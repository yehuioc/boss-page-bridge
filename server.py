"""Loopback-only receiver for user-triggered Boss DOM observations. Python stdlib."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import re
import secrets
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl, urlencode
from job_search import SearchManager, Cancelled
from assistant import AssistantManager
from inquiries import InquiryManager, identity_value

ROOT = Path(__file__).resolve().parent
EXTENSION = re.compile(r'chrome-extension://[a-p]{32}\Z')

def worker_version(version):
    return isinstance(version, str) and re.fullmatch(r'0\.[567]\.\d+', version) is not None


def capture_version(version):
    return isinstance(version, str) and re.fullmatch(r'0\.[67]\.\d+', version) is not None


def validate_interaction(value):
    if not isinstance(value, dict) or set(value) != {'conversation', 'recruiter', 'greeting_visible'} or type(value['greeting_visible']) is not bool:
        raise ValueError('会话观察结构无效')
    recruiter = value['recruiter']
    if recruiter is not None:
        if (not isinstance(recruiter, dict) or set(recruiter) != {'identity', 'contact_label', 'default_greeting'}
                or recruiter['contact_label'] not in ('立即沟通', '继续沟通') or type(recruiter['default_greeting']) is not bool):
            raise ValueError('职位联系人结构无效')
        identity_value(recruiter['identity'])
    convo = value['conversation']
    if convo is not None:
        fields = {'identity', 'messages', 'composer_empty', 'editor_available', 'send_available', 'identity_complete', 'truncated'}
        if (not isinstance(convo, dict) or not fields <= set(convo) <= fields | {'draft_matches'}
                or any(type(convo[k]) is not bool for k in set(convo) - {'identity', 'messages'})
                or not isinstance(convo['messages'], list) or len(convo['messages']) > 80):
            raise ValueError('选中会话结构无效')
        if convo['identity_complete']:
            identity_value(convo['identity'])
        elif (not isinstance(convo['identity'], dict) or set(convo['identity']) != {'hr', 'company', 'avatar', 'job_title', 'job_url'}
              or any(not isinstance(v, (str, type(None))) or isinstance(v, str) and len(v) > 1500 for v in convo['identity'].values())):
            raise ValueError('未完成会话身份无效')
        for m in convo['messages']:
            if (not isinstance(m, dict) or set(m) != {'id', 'direction', 'text', 'failed'} or m['direction'] not in ('hr', 'me', 'system')
                    or not isinstance(m['id'], str) or not 1 <= len(m['id']) <= 100
                    or not isinstance(m['text'], str) or not 1 <= len(m['text']) <= 3000 or type(m['failed']) is not bool):
                raise ValueError('消息观察无效')
    return value


def boss_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError('地址无效')
    url = urlsplit(value)
    if (url.scheme != 'https' or url.hostname not in ('www.zhipin.com', 'zhipin.com')
            or url.username or url.password or url.port not in (None, 443)):
        raise ValueError('只接受 Boss 官网页面')
    return f'https://{url.hostname}{url.path}'


def browse_url(value):
    clean = boss_url(value)
    path = urlsplit(clean).path
    if not (re.fullmatch(r'/job_detail/[^/]+\.html', path) or re.fullmatch(r'/web/geek/(jobs|recommend|chat)', path)
            or re.fullmatch(r'/(?:jiangmen/|c\d+/)?', path) or re.fullmatch(r'/gongsi/(?:job/)?[^/]+\.html', path)):
        raise ValueError('只允许 Boss 的职位、公司和浏览页面')
    keys = {'query', 'city', 'experience', 'degree', 'salary', 'jobType', 'industry', 'scale', 'stage', 'position'}
    query = urlencode([(key, value) for key, value in parse_qsl(urlsplit(value).query) if key in keys])
    return clean + ('?' + query if query else '')


def validate_snapshot(body):
    required = {'url', 'title', 'text', 'truncated', 'links', 'frames', 'ready', 'captured_at', 'scope'}
    optional = {'job', 'salary_image', 'viewport', 'salary_regions', 'selected_detail', 'browser', 'jobs', 'navigation_url', 'blocker', 'binding_session', 'command_id', 'interaction'}
    if not isinstance(body, dict) or not required <= set(body) or set(body) - required - optional:
        raise ValueError('页面结果结构无效')
    for key, limit in [('title', 500), ('text', 40000), ('captured_at', 50)]:
        if not isinstance(body[key], str) or len(body[key]) > limit:
            raise ValueError(f'{key} 无效或过长')
    if (type(body['truncated']) is not bool or type(body['frames']) is not int
            or not 0 <= body['frames'] <= 10000 or body['scope'] != 'top_frame_rendered_dom'
            or body['ready'] not in ('loading', 'interactive', 'complete')):
        raise ValueError('页面范围信息无效')
    if not isinstance(body['links'], list) or len(body['links']) > 50:
        raise ValueError('链接清单无效')
    links = []
    for link in body['links']:
        if (not isinstance(link, dict) or set(link) != {'text', 'url'}
                or not isinstance(link['text'], str) or len(link['text']) > 200):
            raise ValueError('链接内容无效')
        links.append({'text': link['text'], 'url': boss_url(link['url'])})
    safe = {**body, 'url': boss_url(body['url']), 'links': links}
    if 'interaction' in body:
        safe['interaction'] = validate_interaction(body['interaction'])
    if safe.get('blocker') not in (None, 'login_required', 'verification_required'):
        raise ValueError('页面限制状态无效')
    if safe.get('navigation_url'):
        safe['navigation_url'] = browse_url(safe['navigation_url'])
    browser = safe.get('browser')
    if browser is not None:
        if (not isinstance(browser, dict) or not {'key', 'controls'} <= set(browser) or set(browser) - {'key', 'controls', 'filters'} or not isinstance(browser['key'], str)
                or not re.fullmatch(r'[a-f0-9-]{36}', browser['key']) or not isinstance(browser['controls'], list) or len(browser['controls']) > 80):
            raise ValueError('页面控件快照无效')
        for c in browser['controls']:
            if not isinstance(c, dict) or not {'ref', 'kind', 'label', 'href', 'value'} <= set(c) or set(c) - {'ref', 'kind', 'label', 'href', 'value', 'context'}:
                raise ValueError('控件结构无效')
            if 'context' in c and (not isinstance(c['context'], str) or len(c['context']) > 400):
                raise ValueError('控件上下文无效')
            if (not isinstance(c['ref'], str) or not re.fullmatch(r'c\d{1,2}', c['ref'])
                    or c['kind'] not in ('search_input', 'search_button', 'filter', 'filter_option', 'job_link', 'page_link')
                    or not isinstance(c['label'], str) or len(c['label']) > 200
                    or c['value'] is not None and (not isinstance(c['value'], str) or len(c['value']) > 100)):
                raise ValueError('控件字段无效')
            if c['href'] is not None:
                browse_url(c['href'])
        if 'filters' in browser:
            if not isinstance(browser['filters'], list) or len(browser['filters']) > 4:
                raise ValueError('筛选目录无效')
            for group in browser['filters']:
                if (not isinstance(group, dict) or set(group) != {'key', 'label', 'options'}
                        or group['key'] not in ('salary', 'degree', 'experience', 'jobType')
                        or not isinstance(group['label'], str) or len(group['label']) > 30
                        or not isinstance(group['options'], list) or len(group['options']) > 15):
                    raise ValueError('筛选分组无效')
                for option in group['options']:
                    if (not isinstance(option, dict) or set(option) != {'label', 'value', 'selected'}
                            or not isinstance(option['label'], str) or len(option['label']) > 30
                            or not isinstance(option['value'], str) or not re.fullmatch(r'\d{1,10}', option['value'])
                            or type(option['selected']) is not bool):
                        raise ValueError('筛选选项无效')
    if 'jobs' in safe:
        if not isinstance(safe['jobs'], list) or len(safe['jobs']) > 80:
            raise ValueError('职位列表无效')
        job_records = []
        for job_link in safe['jobs']:
            # Boss's footer links to /job_detail/ as a search index, not a vacancy.
            if isinstance(job_link, dict) and set(job_link) == {'text', 'url'} and job_link.get('url') == 'https://www.zhipin.com/job_detail/':
                continue
            if (not isinstance(job_link, dict) or set(job_link) != {'text', 'url'} or not isinstance(job_link['text'], str)
                    or len(job_link['text']) > 200 or not re.fullmatch(r'https://www\.zhipin\.com/job_detail/[^/]+\.html', boss_url(job_link['url']))):
                raise ValueError('职位列表字段无效')
            job_records.append(job_link)
        safe['jobs'] = job_records
    job = safe.get('job')
    if job is not None:
        job_keys = {'layout', 'url', 'title', 'company', 'salary_raw', 'salary', 'salary_status',
                    'location', 'experience', 'education', 'duties', 'requirements', 'description', 'captured_at', 'warnings'}
        if not isinstance(job, dict) or set(job) != job_keys:
            raise ValueError('职位结构无效')
        if job['layout'] not in ('detail_page', 'list_detail') or job['salary_status'] not in ('needs_visual_review', 'dom_text', 'unknown'):
            raise ValueError('职位类型无效')
        job_url = boss_url(job['url'])
        if not re.fullmatch(r'https://www\.zhipin\.com/job_detail/[^/]+\.html', job_url):
            raise ValueError('职位链接无效')
        for key in job_keys - {'warnings'}:
            if job[key] is not None and (not isinstance(job[key], str) or len(job[key]) > 40000):
                raise ValueError('职位字段无效')
        if not isinstance(job['warnings'], list) or len(job['warnings']) > 20 or any(not isinstance(w, str) or len(w) > 1000 for w in job['warnings']):
            raise ValueError('职位提示无效')
        safe['job'] = {**job, 'url': job_url}
    if safe.get('salary_image') is not None:
        decode_salary_image(safe['salary_image'], safe.get('job'))
    # Geometry is only used inside the popup. Do not persist another arbitrary object surface.
    safe.pop('viewport', None)
    safe.pop('salary_regions', None)
    safe.pop('selected_detail', None)
    safe.pop('binding_session', None)
    safe.pop('command_id', None)
    return safe


def decode_salary_image(image, job):
    if not isinstance(image, dict) or set(image) != {'data_url', 'width', 'height', 'source_url', 'captured_at'}:
        raise ValueError('薪资图片结构无效')
    if not job or job['salary_status'] != 'needs_visual_review' or image['source_url'] != job['url']:
        raise ValueError('薪资图片与职位不匹配')
    if type(image['width']) is not int or type(image['height']) is not int or not (0 < image['width'] <= 2400 and 0 < image['height'] <= 500):
        raise ValueError('薪资图片尺寸无效')
    data_url = image['data_url']
    prefix = 'data:image/png;base64,'
    if not isinstance(data_url, str) or not data_url.startswith(prefix) or len(data_url) > 700000:
        raise ValueError('只接受有界的薪资 PNG')
    raw = base64.b64decode(data_url[len(prefix):], validate=True)
    if len(raw) < 45 or not raw.startswith(b'\x89PNG\r\n\x1a\n') or raw[12:16] != b'IHDR':
        raise ValueError('PNG 数据无效')
    if struct.unpack('>II', raw[16:24]) != (image['width'], image['height']):
        raise ValueError('PNG 尺寸与声明不符')
    if image['captured_at'] != job['captured_at']:
        raise ValueError('薪资截图与正文时间不符')
    return raw


class State:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.code = secrets.token_hex(4).upper()
        self.expires = time.time() + 1800
        self.tries = 0
        self.last_seen = None
        self.last_poll = None
        self.binding = None
        self.stopped = set()
        self.commands = {}
        self.last_error = None
        self.blocker = None
        self.client_version = None
        self.server_id = secrets.token_hex(16)
        self.runtime = None
        self.workflow_owner = None
        self.inquiry_authorize = lambda *args: False
        self.latest_capture = None
        self.filter_catalog = []
        self.control_key = secrets.token_urlsafe(32)
        (self.directory / 'control.key').write_text(self.control_key, encoding='utf-8')
        self.auth_file = self.directory / 'connection.json'
        self.auth = json.loads(self.auth_file.read_text('utf-8')) if self.auth_file.exists() else None

    def write(self, name, value):
        destination = self.directory / name
        temporary = destination.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(destination)

    def pair(self, origin, body):
        if not isinstance(body, dict) or set(body) != {'code'} or not isinstance(body['code'], str):
            raise ValueError('配对参数无效')
        self.tries += 1
        if self.tries > 20 or time.time() >= self.expires or not secrets.compare_digest(body['code'].upper(), self.code):
            raise PermissionError('配对码错误或过期；可重启服务生成新码')
        token = secrets.token_urlsafe(32)
        self.auth = {'origin': origin, 'hash': hashlib.sha256(token.encode()).hexdigest()}
        self.poll({'binding': None, 'busy': True})
        self.write('connection.json', self.auth)
        self.expires = 0
        self.last_seen = time.time()
        return {'token': token, 'message': '扩展与本机已连接（尚不代表 Boss 读取成功）'}

    def authenticate(self, origin, authorization):
        digest = hashlib.sha256(authorization.removeprefix('Bearer ').encode()).hexdigest()
        if (not authorization.startswith('Bearer ') or not self.auth or origin != self.auth['origin']
                or not secrets.compare_digest(digest, self.auth['hash'])):
            raise PermissionError('未配对或凭据失效')
        self.last_seen = time.time()

    def poll(self, body):
        if not isinstance(body, dict) or not {'binding', 'busy'} <= set(body) or set(body) - {'binding', 'busy', 'version', 'server_id', 'executing', 'runtime'} or type(body['busy']) is not bool:
            raise ValueError('连接状态无效')
        if worker_version(body.get('version')) and body.get('server_id') != self.server_id:
            raise PermissionError('本机服务已重启，旧接管未恢复，请重新连接')
        executing = body.get('executing')
        if executing is not None and (not isinstance(executing, dict) or set(executing) != {'id', 'session'}
                or any(not isinstance(v, str) or len(v) > 100 for v in executing.values())):
            raise ValueError('执行状态无效')
        if 'version' in body:
            if not isinstance(body['version'], str) or not re.fullmatch(r'\d+\.\d+\.\d+', body['version']):
                raise ValueError('扩展版本无效')
            self.client_version = body['version']
        binding = body['binding']
        if binding is not None:
            if (not isinstance(binding, dict) or set(binding) != {'tab_id', 'session', 'url'}
                    or type(binding['tab_id']) is not int or binding['tab_id'] <= 0
                    or not isinstance(binding['session'], str) or not re.fullmatch(r'[a-f0-9-]{36}', binding['session'])):
                raise ValueError('标签页绑定无效')
            boss_url(binding['url'])
            if binding['session'] in self.stopped:
                raise PermissionError('这次连接已停止，请重新绑定')
        previous = self.binding
        runtime = body.get('runtime')
        if runtime is not None:
            if (not isinstance(runtime, dict) or set(runtime) != {'runner', 'panels', 'tab_active', 'window_state'}
                    or runtime['runner'] != 'background' or type(runtime['panels']) is not int or not 0 <= runtime['panels'] <= 20
                    or type(runtime['tab_active']) is not bool or runtime['window_state'] not in ('normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen')):
                raise ValueError('后台运行状态无效')
            self.runtime = runtime
        if previous and (not binding or previous['session'] != binding['session']):
            self.stopped.add(previous['session'])
            for c in self.commands.values():
                if c['session'] == previous['session'] and c['status'] in ('pending', 'sent'):
                    c.update(status='cancelled', error='用户停止或重新连接')
        self.binding = binding
        self.last_poll = time.time()
        command = None
        for c in self.commands.values():
            if c['status'] in ('pending', 'sent') and c['expires'] <= time.time():
                c.update(status='expired', error='指令超时，未重发')
            if binding and not body['busy'] and c['status'] == 'pending' and c['session'] == binding['session']:
                c['status'] = 'sent'
                c['sent_at'] = time.time()
                command = {k: c[k] for k in ('id', 'session', 'action', 'args', 'expires')}
                break
        running = self.commands.get(executing['id']) if executing else None
        cancel = executing['id'] if executing and (not running or running['session'] != executing['session'] or running['status'] in ('cancelled', 'expired')) else None
        return {'command': command, 'server_id': self.server_id, 'cancel': cancel, 'workflow_active': bool(self.workflow_owner)}

    def enqueue(self, body, owner=None):
        if body == {'action': 'stop', 'args': {}}:
            self.poll({'binding': None, 'busy': True})
            return {'status': 'done', 'stopped': True}
        if self.workflow_owner and owner != self.workflow_owner:
            raise ValueError('找岗任务正在浏览，手动操作请先停止任务')
        if not self.binding or not self.last_poll or time.time() - self.last_poll > 8:
            raise ValueError('Boss 执行器未连接或心跳已中断')
        if not isinstance(body, dict) or set(body) != {'action', 'args'} or not isinstance(body['args'], dict):
            raise ValueError('指令格式无效')
        action, args = body['action'], body['args']
        if self.blocker and action != 'read':
            raise ValueError('Boss 要求登录或验证；请在网页处理后重新读取')
        if action in ('read', 'focus', 'back', 'reload') and args == {}:
            pass
        elif action == 'navigate' and set(args) == {'url'}:
            args = {'url': browse_url(args['url'])}
        elif action in ('input', 'click', 'hover'):
            expected = {'key', 'ref', 'value'} if action == 'input' else {'key', 'ref'}
            if (set(args) != expected or not isinstance(args.get('key'), str) or not re.fullmatch(r'[a-f0-9-]{36}', args['key'])
                    or not isinstance(args.get('ref'), str) or not re.fullmatch(r'c\d{1,2}', args['ref'])):
                raise ValueError('控件引用无效')
            if action == 'input' and (not isinstance(args['value'], str) or not 0 < len(args['value'].strip()) <= 100):
                raise ValueError('搜索词无效')
        elif action == 'scroll' and {'y'} <= set(args) <= {'y', 'target'} and type(args['y']) in (int, float) and -2000 <= args['y'] <= 2000 and args.get('target', 'page') in ('page', 'list', 'detail'):
            if 'target' in args and not capture_version(self.client_version):
                raise ValueError('分区滚动需要0.6扩展')
            pass
        elif action == 'open_job' and set(args) == {'url'} and re.fullmatch(r'https://www\.zhipin\.com/job_detail/[^/]+\.html', boss_url(args['url'])):
            args = {'url': boss_url(args['url'])}
        elif action in ('inquiry_contact', 'inquiry_continue', 'inquiry_send'):
            if (not owner or owner != self.workflow_owner or not str(self.client_version).startswith('0.7.')
                    or not self.inquiry_authorize(action, args, self.binding['session'])):
                raise PermissionError('仅允许执行已确认批次的单次问询；普通控制入口不能发送')
        elif action == 'inquiry_check' and owner and owner == self.workflow_owner and set(args) == {'identity', 'text'}:
            identity_value(args['identity'])
            if not isinstance(args['text'], str) or not 1 <= len(args['text']) <= 500:
                raise ValueError('问询原文无效')
        else:
            raise ValueError('未开放此浏览操作')
        if action in ('navigate', 'back', 'reload', 'input', 'click', 'hover') and self.client_version not in {'0.4.0', '0.4.1'} and not worker_version(self.client_version):
            raise ValueError('请加载新版扩展以使用此操作')
        if action == 'hover' and self.client_version != '0.4.1' and not worker_version(self.client_version):
            raise ValueError('展开筛选需要0.4.1扩展')
        if any(c['status'] in ('pending', 'sent') and c['expires'] > time.time() for c in self.commands.values()):
            raise ValueError('已有指令执行中，未叠加新操作')
        command = {'id': secrets.token_hex(16), 'session': self.binding['session'], 'action': action,
                   'args': args, 'expires': time.time() + 30, 'status': 'pending', 'error': None}
        self.commands = {k: v for k, v in self.commands.items() if v['expires'] > time.time() - 300}
        self.commands[command['id']] = command
        return command

    def result(self, body):
        if not isinstance(body, dict) or set(body) != {'id', 'session', 'error'}:
            raise ValueError('执行回执格式无效')
        c = self.commands.get(body['id'])
        if (not c or c['status'] != 'sent' or c['expires'] <= time.time() or c['session'] != body['session']
                or not self.binding or self.binding['session'] != body['session']):
            raise ValueError('迟到或失效的执行回执')
        if body['error'] is not None and (not isinstance(body['error'], str) or len(body['error']) > 1000):
            raise ValueError('错误回执无效')
        c.update(status='failed' if body['error'] else 'done', error=body['error'])
        self.last_error = body['error']
        if not body['error'] and self.latest_capture and not c.get('capture') and not capture_version(self.client_version):
            record = json.loads((self.directory / self.latest_capture).read_text('utf-8'))
            if record['received_at'] >= c.get('sent_at', float('inf')):
                c['capture'] = self.latest_capture
        return {'accepted': True}


class BridgeTransport:
    def __init__(self, state):
        self.state = state
        self.owner = None

    def acquire(self):
        with self.state.lock:
            if self.state.workflow_owner or any(c['status'] in ('pending', 'sent') and c['expires'] > time.time() for c in self.state.commands.values()):
                raise ValueError('已有浏览操作，请等待完成')
            if not self.state.binding or not self.state.last_poll or time.time() - self.state.last_poll > 8:
                raise ValueError('请先连接当前 Boss 页')
            self.owner = secrets.token_hex(16)
            self.state.workflow_owner = self.owner

    def release(self):
        with self.state.lock:
            if self.state.workflow_owner == self.owner:
                self.state.workflow_owner = None
            self.owner = None

    def session(self):
        with self.state.lock:
            if not self.state.binding or not self.state.last_poll or time.time() - self.state.last_poll > 8:
                raise Cancelled('Boss 接管或心跳已停止')
            return self.state.binding['session']

    def command(self, action, args, cancel):
        with self.state.lock:
            command = self.state.enqueue({'action': action, 'args': args}, owner=self.owner)
        while time.time() < command['expires'] + 1:
            if cancel.wait(.1):
                raise Cancelled('用户停止，本轮未重放操作')
            with self.state.lock:
                if not self.state.binding or self.state.binding['session'] != command['session']:
                    raise Cancelled('Boss 已停止或重新绑定')
                if command['status'] == 'done':
                    path = command.get('capture')
                    if not path:
                        raise ValueError('动作没有对应的页面证据')
                    record = json.loads((self.state.directory / path).read_text('utf-8'))
                    page = record['page']
                    page['_capture'] = path
                    return page
                if command['status'] in ('failed', 'expired', 'cancelled'):
                    raise ValueError(command.get('error') or '动作未完成')
        raise ValueError('浏览动作超时；未重试')

    def stop(self):
        with self.state.lock:
            self.state.enqueue({'action': 'stop', 'args': {}})


class Handler(BaseHTTPRequestHandler):
    server_version = 'BossPageBridge/0.1'

    def log_message(self, *_):
        pass

    def guard(self):
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
            raise PermissionError('Host 不匹配')

    def reply(self, code, value, origin=None):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        if origin and EXTENSION.fullmatch(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        try:
            self.guard()
            origin = self.headers.get('Origin', '')
            if not EXTENSION.fullmatch(origin):
                raise PermissionError('只允许扩展连接')
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'POST')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()
        except PermissionError as error:
            self.reply(403, {'error': str(error)})

    def do_GET(self):
        try:
            self.guard()
            if self.headers.get('Origin') or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise PermissionError('不接受跨站读取')
            if self.path != '/status':
                return self.reply(404, {'error': '不存在此入口'})
            with self.server.state.lock:
                s = self.server.state
                latest = s.directory / 'latest.json'
                snapshot = json.loads(latest.read_text('utf-8')) if latest.exists() else None
                self.reply(200, {'paired': bool(s.auth), 'last_seen': s.last_seen,
                                 'snapshot': snapshot, 'binding': s.binding, 'last_poll': s.last_poll,
                                 'last_error': s.last_error, 'client_version': s.client_version,
                                 'blocker': s.blocker, 'server_id': s.server_id, 'runtime': s.runtime, 'commands': list(s.commands.values())[-10:]})
        except PermissionError as error:
            self.reply(403, {'error': str(error)})

    def do_POST(self):
        origin = self.headers.get('Origin', '')
        try:
            self.guard()
            search_path = self.path.startswith('/search/')
            assistant_path = self.path.startswith(('/assistant/', '/inquiries/'))
            controller = self.path == '/control' or (search_path or assistant_path) and not origin
            if controller:
                if origin or self.headers.get('Sec-Fetch-Site') == 'cross-site' or not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.state.control_key):
                    raise PermissionError('只接受已授权本机控制请求')
            elif not EXTENSION.fullmatch(origin):
                raise PermissionError('只接受 Chrome 扩展请求')
            if self.headers.get('Content-Type') != 'application/json':
                raise ValueError('需要 application/json')
            length = int(self.headers.get('Content-Length', '-1'))
            if not 0 < length <= 1000000:
                raise ValueError('请求大小无效')
            self.connection.settimeout(5)
            body = json.loads(self.rfile.read(length))
            if assistant_path:
                s = self.server.state
                with s.lock:
                    if not controller:
                        s.authenticate(origin, self.headers.get('Authorization', ''))
                model, inquiries = self.server.assistant, self.server.inquiries
                if self.path == '/assistant/state' and body == {}:
                    result = {'assistant': model.view(), 'inquiries': inquiries.view()}
                elif self.path == '/assistant/auth' and body == {}:
                    result = model.model.auth()
                elif self.path == '/assistant/analyze' and isinstance(body, dict) and {'urls'} <= set(body) <= {'urls', 'profile'}:
                    result = model.start(body['urls'], profile=body.get('profile'))
                elif self.path == '/assistant/stop' and body == {}:
                    model.stop(); inquiries.stop(); result = {'stopped': True}
                elif self.path == '/inquiries/prepare' and isinstance(body, dict) and {'urls', 'text'} <= set(body) <= {'urls', 'text', 'current', 'profile'}:
                    from job_search import profile_value
                    result = inquiries.prepare(body['urls'], body['text'], body.get('current', False), profile_value(body.get('profile', {})))
                elif self.path == '/inquiries/template' and isinstance(body, dict) and set(body) == {'text'}:
                    result = inquiries.template(body['text'])
                elif self.path == '/inquiries/approve' and isinstance(body, dict) and set(body) == {'batch_id', 'revision'}:
                    result = inquiries.approve(body['batch_id'], body['revision'])
                elif self.path in ('/inquiries/replies', '/inquiries/analyze-replies') and isinstance(body, dict) and set(body) == {'batch_id', 'item_id'}:
                    result = (inquiries.read_replies if self.path.endswith('/replies') else inquiries.analyze_replies)(body['batch_id'], body['item_id'])
                elif self.path == '/inquiries/permit' and not controller and isinstance(body, dict) and set(body) == {'id', 'session'}:
                    with s.lock:
                        c = s.commands.get(body['id'])
                        if not c or c['status'] != 'sent' or c['expires'] <= time.time() or c['session'] != body['session'] or not s.binding or s.binding['session'] != body['session']:
                            raise PermissionError('问询指令已停止或失效')
                        copy_command = dict(c)
                    result = inquiries.consume(copy_command)
                else:
                    raise ValueError('模型或问询操作无效')
                return self.reply(200, result, origin)
            if search_path:
                s = self.server.state
                with s.lock:
                    if not controller:
                        s.authenticate(origin, self.headers.get('Authorization', ''))
                manager = self.server.search
                if self.path in ('/search/state', '/search/library') and body == {}:
                    run = self.server.assistant.decorate(manager.library() if self.path.endswith('library') else manager.view())
                    # Preview only; complete source text remains in local exports.
                    for candidate in run['candidates'].values():
                        candidate['job']['description'] = candidate['job'].get('description', '')[:600]
                        candidate['job']['duties'] = None
                        candidate['job']['requirements'] = None
                    result = {'run': run, 'filters': s.filter_catalog}
                elif self.path == '/search/start':
                    if not isinstance(body, dict):
                        raise ValueError('找岗参数无效')
                    raw = dict(body)
                    analyze = raw.pop('analyze', False)
                    if type(analyze) is not bool:
                        raise ValueError('模型阅读选项无效')
                    manager.on_complete = (lambda run: self.server.assistant.start(list(run['candidates']), profile=run['profile'])) if analyze else None
                    result = {'run': manager.start(raw), 'filters': s.filter_catalog}
                elif self.path == '/search/stop' and body == {}:
                    result = {'run': manager.stop(), 'filters': s.filter_catalog}
                elif self.path == '/search/export' and isinstance(body, dict) and {'format'} <= set(body) <= {'format','run_id'}:
                    result = {'format': body['format'], 'text': manager.export(body['format'], body.get('run_id'))}
                else:
                    raise ValueError('找岗操作无效')
                return self.reply(200, result, origin)
            with self.server.state.lock:
                s = self.server.state
                if controller:
                    result = s.enqueue(body)
                elif self.path == '/pair':
                    result = s.pair(origin, body)
                else:
                    s.authenticate(origin, self.headers.get('Authorization', ''))
                    if self.path == '/ping' and body == {}:
                        result = {'message': '本机已收到扩展检查，并已回信；Boss 页面未被操作', 'server_id': s.server_id}
                    elif self.path == '/poll':
                        result = s.poll(body)
                    elif self.path == '/result':
                        result = s.result(body)
                    elif self.path == '/revoke':
                        if (not isinstance(body, dict) or set(body) != {'session', 'server_id'}
                                or not isinstance(body['session'], str) or not re.fullmatch(r'[a-f0-9-]{36}', body['session'])
                                or body['server_id'] != s.server_id):
                            raise ValueError('撤销会话无效或本机服务已重启')
                        if s.binding and s.binding['session'] == body['session']:
                            s.poll({'binding': None, 'busy': True})
                        s.stopped.add(body['session'])
                        result = {'stopped': True}
                    elif self.path == '/diagnostic' and isinstance(body, dict) and set(body) == {'error'} and isinstance(body['error'], str) and len(body['error']) <= 1000:
                        s.last_error = body['error']
                        result = {'received': True}
                    elif self.path == '/disconnect' and body == {}:
                        s.poll({'binding': None, 'busy': True})
                        s.auth = None
                        s.write('connection.json', None)
                        result = {'message': '已撤销连接'}
                    elif self.path == '/snapshot':
                        if worker_version(s.client_version) or isinstance(body, dict) and 'binding_session' in body:
                            if (not isinstance(body, dict) or not s.binding or body.get('binding_session') != s.binding['session']
                                    or body.get('binding_session') in s.stopped):
                                raise PermissionError('接管已停止或重新绑定，迟到页面结果未接入')
                        if isinstance(body, dict) and body.get('command_id') is not None:
                            command = s.commands.get(body['command_id']) if isinstance(body['command_id'], str) else None
                            if not command or command['status'] != 'sent' or command['session'] != body.get('binding_session') or command['expires'] <= time.time():
                                raise PermissionError('页面结果未对应当前执行指令，未接入')
                        try:
                            snapshot = validate_snapshot(body)
                        except ValueError as error:
                            if isinstance(body, dict):
                                s.write('last-rejected.json', {'error': str(error), 'url': body.get('url'), 'jobs': body.get('jobs')})
                            raise
                        received_at = time.time()
                        capture_id = str(time.time_ns())
                        (s.directory / 'captures').mkdir(exist_ok=True)
                        if snapshot.get('salary_image'):
                            image = snapshot['salary_image']
                            raw = decode_salary_image(image, snapshot['job'])
                            relative = f'captures/{capture_id}-salary.png'
                            (s.directory / relative).write_bytes(raw)
                            snapshot['salary_image'] = {k: v for k, v in image.items() if k != 'data_url'}
                            snapshot['salary_image']['path'] = relative
                        record = {'received_at': received_at, 'page': snapshot}
                        s.write(f'captures/{capture_id}.json', record)
                        s.write('latest.json', record)
                        s.latest_capture = f'captures/{capture_id}.json'
                        if snapshot.get('browser', {}).get('filters'):
                            s.filter_catalog = snapshot['browser']['filters']
                        command_id = body.get('command_id')
                        if command_id:
                            command = s.commands.get(command_id)
                            if (command and command['session'] == body.get('binding_session') and command['status'] == 'sent'):
                                command['capture'] = s.latest_capture
                        s.last_error = None
                        s.blocker = snapshot.get('blocker')
                        result = {'message': '本机已收到预览；请让 Codex 核对实际内容与页面状态'}
                    else:
                        raise ValueError('未开放此操作')
                self.reply(200, result, origin)
        except PermissionError as error:
            self.reply(403, {'error': str(error)}, origin)
        except (ValueError, TypeError, TimeoutError) as error:
            self.reply(400, {'error': str(error)}, origin)


def make_server(port=8926, directory=None):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.state = State(directory or ROOT / 'private')
    server.search = SearchManager(server.state.directory, BridgeTransport(server.state))
    server.assistant = AssistantManager(server.state.directory, server.search)
    server.search.decorate = server.assistant.decorate
    server.inquiries = InquiryManager(server.state.directory, server.search, BridgeTransport(server.state), server.assistant)
    server.state.inquiry_authorize = server.inquiries.authorized_command
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8926)
    args = parser.parse_args()
    service = make_server(args.port)
    print(f'本机接收服务：http://127.0.0.1:{service.server_port}/status', flush=True)
    print(f'配对码：{service.state.code}（30分钟有效，成功配对后作废）', flush=True)
    print('扩展连接指定 Boss 页后自动回传；Ctrl+C 停止。', flush=True)
    try:
        service.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.assistant.stop()
        service.inquiries.stop()
        if service.assistant.thread:
            service.assistant.thread.join(3)
        service.server_close()
