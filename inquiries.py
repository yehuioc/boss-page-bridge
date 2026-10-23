"""经逐批预览确认的首次问询。批准绑定原文/对象/会话；外发尝试写前日志、不重放。"""
from __future__ import annotations
import copy
import json
import secrets
import threading
import time
from pathlib import Path
from assistant import DEFAULT_TEMPLATE, digest, material, write_json
from job_search import DEFAULT_PROFILE, Cancelled

TERMINAL = {'sent', 'uncertain', 'failed', 'cancelled', 'not_sent'}


def identity_value(value):
    keys = {'hr', 'company', 'avatar', 'job_title', 'job_url'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('HR 身份结构无效')
    for key, limit in [('hr', 100), ('company', 150), ('avatar', 1500), ('job_title', 300)]:
        if not isinstance(value[key], str) or not 1 <= len(value[key]) <= limit:
            raise ValueError('HR 或职位身份不完整；不能准备发送')
    if not value['avatar'].startswith(('https://img.bosszhipin.com/', 'https://img2.bosszhipin.com/')):
        raise ValueError('HR 头像标识无效')
    if value['job_url'] is not None and (not isinstance(value['job_url'], str) or not value['job_url'].startswith('https://www.zhipin.com/job_detail/') or not value['job_url'].endswith('.html')):
        raise ValueError('职位身份无效')
    return copy.deepcopy(value)


def same_identity(expected, actual):
    if not isinstance(actual, dict):
        return False
    return all(expected[k] and expected[k] == actual.get(k) for k in ('hr', 'company', 'avatar', 'job_title')) and not (expected['job_url'] and actual.get('job_url') and expected['job_url'] != actual['job_url'])


class InquiryManager:
    def __init__(self, directory, search, transport, assistant):
        self.directory = Path(directory) / 'inquiries'
        self.path = self.directory / 'state.json'
        self.search, self.transport, self.assistant = search, transport, assistant
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.thread = None
        self.grants = {}
        self.data = json.loads(self.path.read_text('utf-8')) if self.path.exists() else {'status': 'idle', 'message': '尚无待确认问询', 'batches': [], 'template': DEFAULT_TEMPLATE}
        for batch in self.data['batches']:
            if batch['status'] in ('preparing', 'sending', 'approved', 'preview'):
                batch['status'] = 'paused'
            for item in batch['items']:
                if item['status'] not in TERMINAL:
                    item['status'] = 'uncertain' if item.get('attempts') else 'cancelled'
                    item['message'] = '服务曾中断；未自动重发，请核对真实会话'
        self.data.update(status='idle', message='历史问询保留；重启不会重发或恢复批准')
        self._save()

    def _save(self):
        self.data['updated_at'] = time.time()
        write_json(self.path, self.data)

    def view(self):
        with self.lock:
            # Private JD source remains local, preview exposes only fields needed for review.
            value = copy.deepcopy(self.data)
            for batch in value['batches']:
                for item in batch['items']:
                    item.pop('candidate', None)
            return value

    def _batch(self, batch_id):
        found = next((b for b in self.data['batches'] if b['id'] == batch_id), None)
        if not found:
            raise ValueError('问询批次不存在')
        return found

    def _running(self):
        if self.thread and self.thread.is_alive():
            raise ValueError('已有问询操作，请等待或停止')

    def template(self, text):
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
            raise ValueError('初步问询须为1至500字')
        with self.lock:
            self.data['template'] = text.strip()
            self._save()
            return self.view()

    def prepare(self, urls, text, current=False, profile=None):
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
            raise ValueError('初步问询须为1至500字')
        if type(current) is not bool or not isinstance(urls, list) or any(not isinstance(u, str) for u in urls) or len(urls) > 5 or len(set(urls)) != len(urls) or (not current and not urls) or (current and urls):
            raise ValueError('每批选择1至5个岗位，或当前选中 HR')
        entries = self.search.library()['candidates']
        if any(url not in entries for url in urls):
            raise ValueError('只能为已存岗位准备问询')
        with self.lock:
            self._running()
            self.transport.acquire()
            try:
                session = self.transport.session()
                batch = {'id': secrets.token_hex(12), 'status': 'preparing', 'created_at': time.time(), 'session': session,
                         'expires': time.time() + 900, 'items': [], 'text': text.strip(), 'revision': '',
                         'profile': copy.deepcopy(profile or DEFAULT_PROFILE), 'message': '只读核对职位与 HR；尚未发出招呼或询问'}
                self.data['batches'].append(batch)
                self.data.update(status='preparing', template=text.strip(), message=batch['message'])
                self.cancel.clear(); self._save()
                self.thread = threading.Thread(target=self._prepare, args=(batch, [entries[u] for u in urls], current), daemon=True)
                self.thread.start()
            except Exception:
                self.transport.release(); raise
            return self.view()

    def _check(self, batch):
        if self.cancel.is_set() or self.transport.session() != batch['session'] or batch['expires'] <= time.time():
            raise Cancelled('已停止或重新连接；原批准已失效')

    def _command(self, batch, action, args=None):
        self._check(batch)
        result = self.transport.command(action, args or {}, self.cancel)
        self._check(batch)
        return result

    def _prepare(self, batch, candidates, current):
        try:
            targets = [None] if current else candidates
            for candidate in targets:
                page = self._command(batch, 'read' if current else 'open_job', {} if current else {'url': candidate['job']['url']})
                interaction = page.get('interaction') or {}
                target = interaction.get('conversation') if current else interaction.get('recruiter')
                if not target or current and not target.get('identity_complete'):
                    raise ValueError('未能完整核对选中 HR 或职位联系人；未发送')
                identity = identity_value(target['identity'])
                if not current and (not page.get('job') or page['job']['url'] != candidate['job']['url'] or identity['job_url'] != candidate['job']['url']):
                    raise ValueError('职位页面身份不一致')
                if not current and target.get('contact_label') not in ('立即沟通', '继续沟通'):
                    raise ValueError('无法确认沟通按钮用途')
                resume_draft = False
                if current and not target.get('composer_empty'):
                    checked = self._command(batch, 'inquiry_check', {'identity': identity, 'text': batch['text']})
                    target = checked['interaction']['conversation']
                    if not target.get('draft_matches'):
                        raise ValueError('当前输入框已有其他草稿；未覆盖')
                    resume_draft = True
                # Exact repeated question / ambiguous previous attempt never automatically retries.
                for old in self.data['batches']:
                    for item in old['items']:
                        attempted_question = any(a['action'] == 'inquiry_send' and a.get('outcome') != 'not_clicked' for a in item.get('attempts', []))
                        repeated_greeting = not current and target.get('default_greeting') and any(a['action'] == 'inquiry_contact' for a in item.get('attempts', []))
                        if same_identity(identity, item['identity']) and item['text'] == batch['text'] and (attempted_question or repeated_greeting):
                            raise ValueError('该对象已有相同问询尝试；请核对历史记录，不自动重复')
                if current and any(m['direction'] == 'me' and m['text'] == batch['text'] for m in target['messages']):
                    raise ValueError('当前会话已有相同问询；未重复准备')
                item = {'id': secrets.token_hex(12), 'identity': identity, 'text': batch['text'], 'status': 'preview',
                        'route': 'selected' if current else 'job', 'contact_label': None if current else target['contact_label'],
                        'default_greeting': False if current else target['default_greeting'], 'attempts': [], 'message': '等待本批确认',
                        'resume_draft': resume_draft,
                        'candidate': copy.deepcopy(candidate), 'capture': page.get('_capture'), 'observed_at': time.time()}
                with self.lock:
                    batch['items'].append(item); self._save()
            with self.lock:
                batch['revision'] = self.revision(batch)
                batch.update(status='preview', message='请核对岗位、HR、默认招呼提示及实际问询原文。确认后仅发送本批。')
                self.data.update(status='preview', message=batch['message']); self._save()
        except Exception as error:
            with self.lock:
                batch.update(status='failed', message=str(error)[:600]); self.data.update(status='failed', message=batch['message']); self._save()
        finally:
            self.transport.release()

    @staticmethod
    def revision(batch):
        return digest({k: batch[k] for k in ('id', 'session', 'expires', 'profile')} | {'items': [
            {**{k: i[k] for k in ('id', 'identity', 'text', 'route', 'contact_label', 'default_greeting')}, 'resume_draft': i.get('resume_draft', False)} for i in batch['items']]})

    def approve(self, batch_id, revision):
        with self.lock:
            self._running(); batch = self._batch(batch_id)
            if batch['status'] != 'preview' or not batch['items'] or batch['expires'] <= time.time():
                raise ValueError('批次未就绪、已处理或过期；请重新预览')
            if revision != batch['revision'] or revision != self.revision(batch):
                raise ValueError('批次内容改变，原确认无效')
            if self.transport.session() != batch['session']:
                raise ValueError('标签页已重新绑定，请重新预览')
            self.transport.acquire(); self.cancel.clear()
            batch.update(status='sending', approved_at=time.time(), message='仅执行已确认批次；异常时停止、不重发')
            self.data.update(status='sending', message=batch['message']); self._save()
            self.thread = threading.Thread(target=self._send, args=(batch,), daemon=True); self.thread.start()
            return self.view()

    def _external(self, batch, item, action, args):
        self._check(batch)
        grant = secrets.token_hex(24)
        with self.lock:
            # Durable write BEFORE dispatch; process crash cannot make this attempt replayable.
            item['attempts'].append({'action': action, 'time': time.time(), 'status': 'dispatched'})
            item['status'] = 'attempting'; self._save()
            payload = {**args, 'batch_id': batch['id'], 'item_id': item['id'], 'grant': grant}
            self.grants[grant] = {'action': action, 'args': payload, 'session': batch['session'], 'expires': time.time() + 30, 'consumed': False}
        try:
            return self._command(batch, action, payload)
        except Exception as error:
            if action == 'inquiry_send' and str(error).startswith('发送前未点击：'):
                with self.lock:
                    item['attempts'][-1]['outcome'] = 'not_clicked'
                    item.update(status='not_sent', message=str(error)); self._save()
            raise
        finally:
            with self.lock:
                self.grants.pop(grant, None)

    def authorized_command(self, action, args, session):
        # Called with the bridge lock; never acquire our lock in reverse order.
        grant = self.grants.get(args.get('grant'))
        return bool(grant and not grant['consumed'] and grant['expires'] > time.time() and grant['session'] == session
                    and grant['action'] == action and grant['args'] == args and not self.cancel.is_set())

    def consume(self, command):
        with self.lock:
            if not self.authorized_command(command['action'], command['args'], command['session']):
                raise ValueError('问询授权已失效、已使用或内容不符')
            self.grants[command['args']['grant']]['consumed'] = True
            return {'allowed': True}

    def _open(self, batch, item):
        if item['route'] == 'selected':
            page = self._command(batch, 'read')
        else:
            page = self._command(batch, 'open_job', {'url': item['identity']['job_url']})
            recruiter = (page.get('interaction') or {}).get('recruiter')
            if not recruiter or not same_identity(item['identity'], recruiter['identity']) or recruiter['contact_label'] != item['contact_label']:
                raise ValueError('职位联系人或沟通状态已改变，请重新预览')
            page = self._external(batch, item, 'inquiry_contact', {'identity': item['identity'], 'label': item['contact_label']})
            if (page.get('interaction') or {}).get('greeting_visible'):
                page = self._external(batch, item, 'inquiry_continue', {'identity': item['identity']})
        conversation = (page.get('interaction') or {}).get('conversation')
        if not conversation or not conversation.get('identity_complete') or not same_identity(item['identity'], conversation['identity']):
            raise ValueError('打开后的会话不属于已确认 HR/职位；未追加问询')
        return page

    def _send(self, batch):
        try:
            for item in batch['items']:
                self._check(batch)
                page = self._open(batch, item)
                convo = page['interaction']['conversation']
                if not convo['composer_empty'] and not (item.get('resume_draft') and convo.get('draft_matches')):
                    raise ValueError('会话已有未发送草稿，未覆盖')
                if any(m['direction'] == 'me' and m['text'] == item['text'] for m in convo['messages']):
                    raise ValueError('会话已存在相同问询，未重复发送')
                previous = {m['id'] for m in convo['messages']}
                page = self._external(batch, item, 'inquiry_send', {'identity': item['identity'], 'text': item['text'], 'resume_draft': item.get('resume_draft', False)})
                observed = (page.get('interaction') or {}).get('conversation')
                if not observed or not same_identity(item['identity'], observed['identity']):
                    raise ValueError('发送后会话身份无法核对')
                fresh = [m for m in observed['messages'] if m['id'] not in previous and m['direction'] == 'me' and m['text'] == item['text'] and not m['failed']]
                if not fresh or not observed['composer_empty']:
                    raise ValueError('未取得新的本人消息回显，发送状态不确定；未重试')
                with self.lock:
                    item.update(status='sent', message='已观察到新消息回显；不代表对方已读', sent_at=time.time(), sent_message_id=fresh[-1]['id'], capture=page.get('_capture'))
                    self._save()
            with self.lock:
                batch.update(status='done', message='本批已发送并核对新消息回显；后续回复须主动读取，不自动续聊')
                self.data.update(status='done', message=batch['message']); self._save()
        except Exception as error:
            with self.lock:
                for item in batch['items']:
                    if item['status'] not in TERMINAL:
                        item.update(status='uncertain' if item['attempts'] else 'cancelled', message=str(error)[:600])
                batch.update(status='paused', message=str(error)[:600]); self.data.update(status='paused', message=batch['message']); self._save()
        finally:
            self.transport.release()

    def stop(self):
        self.cancel.set()
        self.transport.stop()
        with self.lock:
            self.grants.clear()
            self.data.update(status='stopping' if self.thread and self.thread.is_alive() else 'paused', message='已停止；未完成问询不自动重发')
            for batch in self.data['batches']:
                if batch['status'] == 'preview':
                    batch.update(status='cancelled', message='用户停止，原预览已撤销')
            self._save(); return self.view()

    def read_replies(self, batch_id, item_id):
        # This operation never initiates contact or navigates by clicking a greeting button.
        with self.lock:
            self._running(); batch = self._batch(batch_id)
            item = next((i for i in batch['items'] if i['id'] == item_id), None)
            if not item:
                raise ValueError('问询对象不存在')
            self.transport.acquire(); self.cancel.clear()
            session = self.transport.session()
            self.thread = threading.Thread(target=self._read_replies, args=(batch, item, session), daemon=True)
            self.thread.start(); return self.view()

    def _read_replies(self, batch, item, session):
        try:
            page = self.transport.command('read', {}, self.cancel)
            if self.transport.session() != session or self.cancel.is_set():
                raise ValueError('读取时接管已改变')
            convo = (page.get('interaction') or {}).get('conversation')
            if not convo or not convo.get('identity_complete') or not same_identity(item['identity'], convo['identity']):
                raise ValueError('请在消息页选中本批对应 HR；本次未读取其他会话')
            messages = convo['messages']
            # Read-only reconciliation for a delayed/misparsed echo. Never repeat
            # the send: compare a NEW ID against this item's pre-send capture.
            if item['status'] == 'uncertain' and any(a['action'] == 'inquiry_send' for a in item['attempts']) and item.get('capture'):
                capture = (self.directory.parent / item['capture']).resolve()
                base = (self.directory.parent / 'captures').resolve()
                if capture.is_relative_to(base) and capture.is_file():
                    before = json.loads(capture.read_text('utf-8'))['page'].get('interaction', {}).get('conversation') or {}
                    ids = {m['id'] for m in before.get('messages', [])}
                    found = [m for m in messages if m['direction'] == 'me' and m['text'] == item['text'] and m['id'] not in ids and not m['failed']]
                    if len(found) == 1 and convo['composer_empty']:
                        with self.lock:
                            item['reconciliation'] = {'previous_status': item['status'], 'previous_message': item['message'], 'capture': page.get('_capture'), 'time': time.time(), 'action': 'read_only_no_resend'}
                            item.update(status='sent', message='已只读核对新增消息及原文；未重发', sent_message_id=found[0]['id'])
                            if all(i['status'] == 'sent' for i in batch['items']):
                                batch.update(status='done', message='本批新消息回显已核对；未重发，后续不自动续聊')
                                self.data['status'] = 'done'
                            self._save()
            if item.get('sent_message_id'):
                positions = [n for n,m in enumerate(messages) if m['id'] == item['sent_message_id']]
                if not positions:
                    raise ValueError('当前可见消息未包含本次问询；不能认定后续回复范围')
                messages = messages[positions[-1] + 1:]
            replies = [m for m in messages if m['direction'] == 'hr']
            with self.lock:
                item.update(replies=replies, replies_at=time.time(), reply_capture=page.get('_capture'))
                self.data.update(message='已读取该 HR 当前加载的文字回复；未自动发送后续消息' if replies else '当前未观察到可分析的 HR 文字回复')
                self._save()
        except Exception as error:
            with self.lock:
                self.data.update(message=str(error)[:600]); self._save()
        finally:
            self.transport.release()

    def analyze_replies(self, batch_id, item_id):
        with self.lock:
            batch = self._batch(batch_id)
            item = next((i for i in batch['items'] if i['id'] == item_id), None)
            if not item or not item.get('replies'):
                raise ValueError('请先读取对应 HR 的回复')
            linked = {i['candidate']['job']['url']:i['candidate'] for b in self.data['batches'] if b.get('approved_at')
                      for i in b['items'] if i.get('candidate') and same_identity(item['identity'],i['identity'])}
            candidate = item.get('candidate') or (next(iter(linked.values())) if len(linked) == 1 else None) or {'job': {'url': 'conversation:' + digest(item['identity']),
                'title': item['identity']['job_title'], 'company': item['identity']['company'], 'description': ''}, 'profile': batch['profile']}
            source = material({**candidate, 'profile': batch['profile']}, item['replies'])
            item['analysis_url'] = source['url']; self._save()
        return self.assistant.start_sources([source])
