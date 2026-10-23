import copy
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from assistant import AssistantManager, DEFAULT_TEMPLATE, digest, material, validate_result
from inquiries import InquiryManager
# Synthetic profile used only in isolated tests.
DEFAULT_PROFILE = {"keywords":["合成测试岗位"],"city":"全国","remote":False,"part_time":False,"education":"学历不限","experience_years":2,"filters":{},"limit":12}
from server import State, validate_interaction

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://www.zhipin.com/job_detail/test.html'
IDENTITY = {'hr': '测试 HR', 'company': '测试公司', 'avatar': 'https://img.bosszhipin.com/avatar/person.jpeg', 'job_title': '账号运营', 'job_url': URL}
CANDIDATE = {'job': {'url': URL, 'title': '账号运营', 'company': '测试公司', 'description': '负责账号内容整理与日常运营。'}, 'profile': DEFAULT_PROFILE, 'read_at': 1}


class Search:
    def library(self):
        return {'profile': DEFAULT_PROFILE, 'candidates': {URL: copy.deepcopy(CANDIDATE)}}


def model_result(source):
    return {'items': [{'url': source['url'], 'decision': 'ask_hr', 'summary': '整理账号内容，工作安排不明。', 'reason': '未交代办公地点和时间安排，不能因此排除。',
                       'evidence': [{'source': 'jd', 'quote': '负责账号内容整理与日常运营。', 'meaning': '日常内容运营'}],
                       'unknowns': ['远程和兼职安排'], 'questions': ['是否支持远程兼职？']}]}


class Transport:
    def __init__(self):
        self.owner = None; self.session_id = 'session'; self.calls = []; self.manager = None
        self.wrong = False; self.fail_after_send = False; self.messages = []; self.draft = False

    def acquire(self):
        if self.owner:
            raise ValueError('busy')
        self.owner = 'owner'

    def release(self):
        self.owner = None

    def session(self):
        return self.session_id

    def stop(self):
        self.session_id = 'stopped'

    def page(self, recruiter=False):
        identity = {**IDENTITY, 'hr': '错误 HR'} if self.wrong else IDENTITY
        return {'job': CANDIDATE['job'], '_capture': 'captures/test.json',
                'interaction': {'recruiter': {'identity': IDENTITY, 'contact_label': '立即沟通', 'default_greeting': True} if recruiter else None,
                                'conversation': None if recruiter else {'identity': identity, 'identity_complete': True,
                                     'composer_empty': not self.draft, 'messages': copy.deepcopy(self.messages)}, 'greeting_visible': False}}

    def command(self, action, args, cancel):
        self.calls.append(action)
        if action.startswith('inquiry_'):
            # Evidence of attempt must already exist on disk before any click.
            data = json.loads(self.manager.path.read_text('utf-8'))
            self.assert_recorded = any(a['action'] == action for a in data['batches'][-1]['items'][0]['attempts'])
            assert self.assert_recorded
            assert self.manager.authorized_command(action, args, self.session_id)
            self.manager.consume({'action': action, 'args': args, 'session': self.session_id})
            assert not self.manager.authorized_command(action, args, self.session_id)
        if action == 'inquiry_send':
            self.messages.append({'id': 'new-message', 'direction': 'me', 'text': args['text'], 'failed': False})
            if self.fail_after_send:
                raise ValueError('连接在发送后断开')
        return self.page(action == 'open_job')


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'private').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'private')
        self.root = Path(self.temp.name)
        self.transport = Transport()
        self.assistant = AssistantManager(self.root, Search())
        self.manager = InquiryManager(self.root, Search(), self.transport, self.assistant)
        self.transport.manager = self.manager

    def tearDown(self):
        self.temp.cleanup()

    def preview(self, current=True):
        self.manager.prepare([] if current else [URL], DEFAULT_TEMPLATE, current)
        self.manager.thread.join(2)
        self.assertFalse(self.manager.thread.is_alive())
        return self.manager.data['batches'][-1]

    def test_preview_has_no_message_effect_and_changed_text_or_session_invalidates_approval(self):
        batch = self.preview()
        self.assertEqual(self.transport.calls, ['read'])
        original = batch['revision']; batch['items'][0]['text'] = '其他文本'
        with self.assertRaisesRegex(ValueError, '内容改变'):
            self.manager.approve(batch['id'], original)
        batch['items'][0]['text'] = DEFAULT_TEMPLATE
        self.transport.session_id = 'different'
        with self.assertRaisesRegex(ValueError, '重新绑定'):
            self.manager.approve(batch['id'], original)

    def test_one_approved_batch_is_single_use_and_new_echo_is_required(self):
        batch = self.preview()
        self.manager.approve(batch['id'], batch['revision']); self.manager.thread.join(2)
        self.assertEqual(batch['items'][0]['status'], 'sent')
        self.assertEqual(self.transport.calls.count('inquiry_send'), 1)
        with self.assertRaises(ValueError):
            self.manager.approve(batch['id'], batch['revision'])
        again = self.preview()
        self.assertEqual(again['status'], 'failed')
        self.assertEqual(self.transport.calls.count('inquiry_send'), 1)

    def test_wrong_recipient_and_existing_draft_never_send(self):
        batch = self.preview(); self.transport.wrong = True
        self.manager.approve(batch['id'], batch['revision']); self.manager.thread.join(2)
        self.assertEqual(batch['items'][0]['status'], 'cancelled')
        self.assertNotIn('inquiry_send', self.transport.calls)

    def test_new_contact_includes_default_greeting_but_revalidates_after_open(self):
        batch = self.preview(False)
        self.assertTrue(batch['items'][0]['default_greeting'])
        self.assertNotIn('inquiry_contact', self.transport.calls)
        self.transport.wrong = True
        self.manager.approve(batch['id'], batch['revision']); self.manager.thread.join(2)
        self.assertIn('inquiry_contact', self.transport.calls)
        self.assertNotIn('inquiry_send', self.transport.calls)
        self.assertEqual(batch['items'][0]['status'], 'uncertain')

    def test_uncertain_send_and_restart_never_replay(self):
        batch = self.preview(); self.transport.fail_after_send = True
        self.manager.approve(batch['id'], batch['revision']); self.manager.thread.join(2)
        self.assertEqual(batch['items'][0]['status'], 'uncertain')
        recovered = InquiryManager(self.root, Search(), self.transport, self.assistant)
        with self.assertRaises(ValueError):
            recovered.approve(batch['id'], batch['revision'])
        self.assertEqual(self.transport.calls.count('inquiry_send'), 1)

    def test_definite_preclick_failure_is_saved_without_claiming_a_message_was_sent(self):
        batch = self.preview()
        original = self.transport.command
        def blocked(action, args, cancel):
            if action == 'inquiry_send':
                raise ValueError('发送前未点击：目标控件不可用')
            return original(action, args, cancel)
        self.transport.command = blocked
        self.manager.approve(batch['id'], batch['revision']); self.manager.thread.join(2)
        item = batch['items'][0]
        self.assertEqual(item['status'], 'not_sent')
        self.assertEqual(item['attempts'][-1]['outcome'], 'not_clicked')
        self.assertEqual(self.transport.messages, [])

    def test_restart_and_stop_revoke_unsent_previews(self):
        batch = self.preview()
        recovered = InquiryManager(self.root, Search(), self.transport, self.assistant)
        with self.assertRaises(ValueError):
            recovered.approve(batch['id'], batch['revision'])
        self.manager.stop()
        with self.assertRaises(ValueError):
            self.manager.approve(batch['id'], batch['revision'])

    def test_plain_control_cannot_send_even_if_heartbeat_and_workflow_are_present(self):
        state = State(self.root)
        state.binding = {'session': 'session'}; state.last_poll = time.time(); state.client_version = '0.7.0'
        state.workflow_owner = 'owner'
        with self.assertRaises((ValueError, PermissionError)):
            state.enqueue({'action': 'inquiry_send', 'args': {'text': 'hello'}})
        with self.assertRaises(PermissionError):
            state.enqueue({'action': 'inquiry_send', 'args': {'text': 'hello'}}, owner='owner')

    def test_replies_are_limited_to_selected_identity_and_later_than_this_question(self):
        batch = self.preview(); item = batch['items'][0]
        item['sent_message_id'] = 'mine'
        self.transport.messages = [{'id': 'old', 'direction': 'hr', 'text': '旧消息', 'failed': False},
                                   {'id': 'mine', 'direction': 'me', 'text': item['text'], 'failed': False},
                                   {'id': 'answer', 'direction': 'hr', 'text': '支持远程兼职', 'failed': False}]
        self.manager.read_replies(batch['id'], item['id']); self.manager.thread.join(2)
        self.assertEqual([m['id'] for m in item['replies']], ['answer'])
        self.assertEqual(self.transport.calls.count('inquiry_send'), 0)

    def test_uncertain_echo_can_be_reconciled_by_reading_but_never_by_sending_again(self):
        batch = self.preview(); item = batch['items'][0]
        path = self.root/'captures/test.json'; path.parent.mkdir()
        path.write_text(json.dumps({'page':{'interaction':{'conversation':{'messages':[]}}}}),'utf-8')
        item.update(status='uncertain',attempts=[{'action':'inquiry_send'}])
        self.transport.messages=[{'id':'fresh','direction':'me','text':item['text'],'failed':False}]
        self.manager.read_replies(batch['id'],item['id']); self.manager.thread.join(2)
        self.assertEqual(item['status'],'sent');self.assertEqual(item['sent_message_id'],'fresh')
        self.assertEqual(item['reconciliation']['action'],'read_only_no_resend')
        self.assertNotIn('inquiry_send',self.transport.calls)

    def test_an_old_identical_message_cannot_reconcile_an_uncertain_attempt(self):
        batch = self.preview(); item = batch['items'][0]
        message={'id':'old','direction':'me','text':item['text'],'failed':False}
        path=self.root/'captures/test.json';path.parent.mkdir()
        path.write_text(json.dumps({'page':{'interaction':{'conversation':{'messages':[message]}}}}),'utf-8')
        item.update(status='uncertain',attempts=[{'action':'inquiry_send'}]);self.transport.messages=[message]
        self.manager.read_replies(batch['id'],item['id']);self.manager.thread.join(2)
        self.assertEqual(item['status'],'uncertain');self.assertNotIn('inquiry_send',self.transport.calls)

    def test_model_requires_exact_job_ids_and_real_quotes_and_preserves_unknown(self):
        source = material(CANDIDATE)
        result = validate_result(model_result(source), [source])
        self.assertEqual(result[URL]['decision'], 'ask_hr')
        bad = model_result(source); bad['items'][0]['evidence'][0]['quote'] = '支持居家办公'
        with self.assertRaisesRegex(ValueError, '引用不在'):
            validate_result(bad, [source])
        bad = model_result(source); bad['items'][0]['url'] += 'wrong'
        with self.assertRaises(ValueError):
            validate_result(bad, [source])

    def test_model_material_excludes_contacts_and_failed_results_cannot_replace_saved_judgment(self):
        c = copy.deepcopy(CANDIDATE); c['job']['description'] += '\n微信：abc12345 手机13912345678'
        source = material(c, [{'id': '1', 'text': '支持兼职，电话13912345678'}])
        self.assertNotIn('13912345678', json.dumps(source)); self.assertNotIn('abc12345', json.dumps(source))
        class Model:
            def analyze(self, sources, cancel):
                raise ValueError('模型失败')
        manager = AssistantManager(self.root, Search(), Model())
        manager.start([URL]); manager.thread.join(2)
        self.assertEqual(manager.view()['status'], 'failed')
        self.assertEqual(manager.view()['results'], {})

    def test_hr_reply_analysis_uses_only_supplied_replies_and_is_saved_separately_from_jd(self):
        class Model:
            def analyze(self, sources, cancel):
                self.sources = sources
                result = model_result(sources[0]); item = result['items'][0]
                item.update(decision='keep', evidence=[{'source':'hr','quote':'支持远程兼职','meaning':'HR补充了工作安排'}])
                return validate_result(result, sources)
        model = Model(); manager = AssistantManager(self.root, Search(), model)
        manager.start([URL], replies={URL:[{'id':'reply','text':'支持远程兼职'}]}, profile=DEFAULT_PROFILE)
        manager.thread.join(2)
        result = manager.view()['results'][URL]
        self.assertTrue(result['used_hr_replies'])
        self.assertEqual(result['evidence'][0]['source'],'hr')
        self.assertEqual(model.sources[0]['hr_replies'],[{'id':'reply','text':'支持远程兼职'}])
        self.assertEqual(CANDIDATE['job']['description'],'负责账号内容整理与日常运营。')

    def test_cancelled_model_cannot_save_a_late_result(self):
        entered = threading.Event(); release = threading.Event()
        class Model:
            def analyze(self, sources, cancel):
                entered.set(); release.wait(2)
                return validate_result(model_result(sources[0]),sources)
        manager = AssistantManager(self.root, Search(), Model())
        manager.start([URL]); self.assertTrue(entered.wait(1)); manager.stop(); release.set(); manager.thread.join(2)
        self.assertEqual(manager.view()['status'],'paused'); self.assertEqual(manager.view()['results'],{})


if __name__ == '__main__':
    unittest.main()
