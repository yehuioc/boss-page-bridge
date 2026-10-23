import http.client
import base64
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
import server


ORIGIN = 'chrome-extension://' + 'a' * 32


def sample():
    return {'url': 'https://www.zhipin.com/job_detail/example.html?token=do-not-store',
            'title': '合成职位', 'text': '合成职位正文，不是 Boss 实测结果', 'truncated': False,
            'links': [], 'frames': 0, 'ready': 'complete',
            'captured_at': '2026-10-23T00:00:00Z', 'scope': 'top_frame_rendered_dom'}


class BridgeTests(unittest.TestCase):
    def test_search_routes_require_authorization_and_workflow_lease_blocks_manual_commands(self):
        token=self.pair()
        self.assertEqual(self.call('/search/state', {}, origin=None)[0],403)
        self.assertEqual(self.call('/search/state', {}, token)[0],200)
        self.assertEqual(self.call('/search/export', {'format':'html'},token)[0],400)
        self.assertEqual(self.call('/search/start', {'limit':100},token)[0],400)
        s=self.service.state
        s.poll({'binding':{'tab_id':12,'session':'12345678-1234-1234-1234-123456789abc','url':'https://www.zhipin.com/web/geek/jobs'},'busy':False,'version':'0.6.0','server_id':s.server_id})
        transport=server.BridgeTransport(s);transport.acquire()
        self.assertEqual(self.call('/control',{'action':'read','args':{}},s.control_key,origin=None)[0],400)
        transport.stop();transport.release()
        self.assertIsNone(s.binding)
        self.assertIsNone(s.workflow_owner)

    def test_06_transport_requires_fresh_snapshot_for_exact_command(self):
        token=self.pair();s=self.service.state
        binding={'tab_id':12,'session':'12345678-1234-1234-1234-123456789abc','url':'https://www.zhipin.com/web/geek/jobs'}
        poll={'binding':binding,'busy':False,'version':'0.6.0','server_id':s.server_id}
        s.poll(poll);transport=server.BridgeTransport(s);transport.acquire()
        output=[];failures=[]
        def run():
            try:output.append(transport.command('read',{},threading.Event()))
            except Exception as error:failures.append(str(error))
        t=threading.Thread(target=run);t.start()
        deadline=time.time()+2
        while not s.commands and time.time()<deadline:time.sleep(.01)
        command=self.call('/poll',poll,token)[1]['command']
        snapshot={**sample(),'binding_session':binding['session'],'command_id':'unknown'}
        self.assertEqual(self.call('/snapshot',snapshot,token)[0],403)
        self.assertEqual(self.call('/snapshot',{**snapshot,'command_id':command['id']},token)[0],200)
        self.call('/result',{'id':command['id'],'session':binding['session'],'error':None},token)
        t.join(2);self.assertEqual(len(output),1);self.assertFalse(failures)
        self.assertTrue(output[0]['_capture'].startswith('captures/'))
        old_id=command['id'];t=threading.Thread(target=run);t.start()
        deadline=time.time()+2
        while len(s.commands)<2 and time.time()<deadline:time.sleep(.01)
        command=self.call('/poll',poll,token)[1]['command']
        self.assertNotEqual(command['id'],old_id)
        self.call('/result',{'id':command['id'],'session':binding['session'],'error':None},token)
        t.join(2);self.assertEqual(len(failures),1);self.assertIn('没有对应',failures[0])
        transport.release()

    def test_background_boot_identity_stop_and_late_snapshot_boundary(self):
        token = self.pair()
        server_id = self.call('/ping', {}, token)[1]['server_id']
        binding = {'tab_id': 12, 'session': '12345678-1234-1234-1234-123456789abc', 'url': 'https://www.zhipin.com/web/geek/jobs'}
        poll = {'binding': binding, 'busy': False, 'version': '0.5.3', 'server_id': server_id,
                'runtime': {'runner': 'background', 'panels': 0, 'tab_active': False, 'window_state': 'minimized'}}
        self.assertEqual(self.call('/poll', poll, token)[0], 200)
        self.assertEqual(self.call('/status', origin=None, method='GET')[1]['runtime'], poll['runtime'])
        body = {**sample(), 'binding_session': binding['session']}
        self.assertEqual(self.call('/snapshot', body, token)[0], 200)
        self.assertEqual(self.call('/snapshot', sample(), token)[0], 403)
        self.call('/control', {'action': 'stop', 'args': {}}, self.service.state.control_key, origin=None)
        self.assertEqual(self.call('/snapshot', body, token)[0], 403)
        self.assertEqual(self.call('/poll', poll, token)[0], 403)
        self.service.state = server.State(self.temp.name)
        self.assertEqual(self.call('/poll', poll, token)[0], 403)
        self.assertIsNone(self.service.state.binding)

    def test_background_revocation_cannot_stop_a_newer_binding_and_expired_job_is_cancelled(self):
        token = self.pair()
        s = self.service.state
        binding = {'tab_id': 12, 'session': '12345678-1234-1234-1234-123456789abc', 'url': 'https://www.zhipin.com/web/geek/jobs'}
        poll = {'binding': binding, 'busy': False, 'version': '0.5.0', 'server_id': s.server_id}
        self.call('/poll', poll, token)
        key = s.control_key
        command = self.call('/control', {'action': 'read', 'args': {}}, key, origin=None)[1]
        self.call('/poll', poll, token)
        s.commands[command['id']]['expires'] = time.time() - 1
        result = self.call('/poll', {**poll, 'busy': True, 'executing': {'id': command['id'], 'session': binding['session']}}, token)[1]
        self.assertEqual(result['cancel'], command['id'])
        new_binding = {**binding, 'session': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}
        self.call('/poll', {**poll, 'binding': new_binding}, token)
        self.assertEqual(self.call('/revoke', {'session': binding['session'], 'server_id': s.server_id}, token)[0], 200)
        self.assertEqual(s.binding, new_binding)
        self.assertEqual(self.call('/poll', poll, token)[0], 403)

    def test_footer_search_index_is_not_a_job_and_external_job_urls_are_rejected(self):
        valid = {'text': '工程师', 'url': 'https://www.zhipin.com/job_detail/example.html'}
        body = {**sample(), 'jobs': [valid, {'text': '职位搜索', 'url': 'https://www.zhipin.com/job_detail/'}]}
        self.assertEqual(server.validate_snapshot(body)['jobs'], [valid])
        with self.assertRaises(ValueError):
            server.validate_snapshot({**sample(), 'jobs': [{'text': '坏链接', 'url': 'https://evil.example/'}]})

    def setUp(self):
        private = Path(__file__).resolve().parents[1] / 'private'
        private.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=private)
        self.service = server.make_server(0, self.temp.name)
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.service.shutdown()
        self.service.server_close()
        self.thread.join(2)
        self.temp.cleanup()

    def call(self, path, body=None, token='', origin=ORIGIN, host=None, method='POST'):
        connection = http.client.HTTPConnection('127.0.0.1', self.service.server_port, timeout=3)
        headers = {'Content-Type': 'application/json'}
        if origin is not None:
            headers['Origin'] = origin
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if host:
            headers['Host'] = host
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else b'{}'
        connection.request(method, path, data, headers)
        result = connection.getresponse()
        status, payload = result.status, json.loads(result.read())
        connection.close()
        return status, payload

    def pair(self):
        status, result = self.call('/pair', {'code': self.service.state.code})
        self.assertEqual(status, 200)
        return result['token']

    def test_real_http_pair_ping_snapshot_and_restart(self):
        token = self.pair()
        self.assertEqual(self.call('/ping', {}, token)[0], 200)
        self.assertEqual(self.call('/snapshot', sample(), token)[0], 200)
        status, result = self.call('/status', origin=None, method='GET')
        self.assertEqual(status, 200)
        self.assertEqual(result['snapshot']['page']['url'], 'https://www.zhipin.com/job_detail/example.html')
        self.service.state = server.State(self.temp.name)
        self.assertEqual(self.call('/ping', {}, token)[0], 200)
        self.assertEqual(self.call('/disconnect', {}, token)[0], 200)
        self.assertEqual(self.call('/ping', {}, token)[0], 403)
        self.service.state = server.State(self.temp.name)
        self.assertEqual(self.call('/ping', {}, token)[0], 403)

    def test_unauthorized_sources_cannot_pair_or_read(self):
        for origin in [None, 'null', 'https://www.zhipin.com', 'https://evil.example']:
            self.assertEqual(self.call('/pair', {'code': self.service.state.code}, origin=origin)[0], 403)
        self.assertEqual(self.call('/status', method='GET', origin='https://evil.example')[0], 403)
        self.assertEqual(self.call('/status', method='GET', origin=None, host='evil.example')[0], 403)

    def test_wrong_code_replay_and_foreign_extension(self):
        self.assertEqual(self.call('/pair', {'code': 'WRONG'})[0], 403)
        token = self.pair()
        self.assertEqual(self.call('/pair', {'code': self.service.state.code})[0], 403)
        self.assertEqual(self.call('/ping', {}, token, origin='chrome-extension://' + 'b' * 32)[0], 403)
        self.assertEqual(self.call('/ping', {})[0], 403)

    def test_reject_foreign_pages_bad_shape_and_oversize_without_overwriting(self):
        token = self.pair()
        self.assertEqual(self.call('/snapshot', sample(), token)[0], 200)
        invalid = [
            {**sample(), 'url': 'https://www.zhipin.com.evil.example/'},
            {**sample(), 'url': 'https://user:secret@www.zhipin.com/'},
            {**sample(), 'text': 'x' * 40001},
            {**sample(), 'links': [{'text': 'link', 'url': 'https://evil.example/'}]},
            {**sample(), 'cookies': 'not-allowed'},
            [],
        ]
        for item in invalid:
            self.assertEqual(self.call('/snapshot', item, token)[0], 400)
        stored = json.loads((Path(self.temp.name) / 'latest.json').read_text('utf-8'))
        self.assertEqual(stored['page']['text'], sample()['text'])

    def test_salary_crop_is_saved_separately_and_bound_to_job(self):
        token = self.pair()
        job = dict.fromkeys(['title', 'company', 'salary_raw', 'salary', 'location', 'experience',
                            'education', 'duties', 'requirements', 'description'])
        job.update(layout='detail_page', url='https://www.zhipin.com/job_detail/example.html',
                   salary_status='needs_visual_review', captured_at=sample()['captured_at'], warnings=[])
        png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKXcAAAAASUVORK5CYII='
        image = {'data_url': 'data:image/png;base64,' + png, 'width': 1, 'height': 1,
                 'source_url': job['url'], 'captured_at': job['captured_at']}
        body = {**sample(), 'job': job, 'salary_image': image}
        self.assertEqual(self.call('/snapshot', body, token)[0], 200)
        record = json.loads((Path(self.temp.name) / 'latest.json').read_text('utf-8'))
        saved = record['page']['salary_image']
        self.assertNotIn('data_url', saved)
        self.assertEqual((Path(self.temp.name) / saved['path']).read_bytes(), base64.b64decode(png))
        self.assertEqual(self.call('/snapshot', {**body, 'salary_image': {**image, 'source_url': 'https://www.zhipin.com/job_detail/other.html'}}, token)[0], 400)
        self.assertEqual(self.call('/snapshot', {**body, 'salary_image': {**image, 'width': 2401}}, token)[0], 400)
        self.assertEqual(self.call('/snapshot', {**body, 'salary_image': {**image, 'captured_at': 'old'}}, token)[0], 400)

    def test_controller_commands_require_local_secret_and_session_and_are_not_replayed(self):
        token = self.pair()
        binding = {'tab_id': 12, 'session': '12345678-1234-1234-1234-123456789abc', 'url': 'https://www.zhipin.com/web/geek/jobs'}
        self.assertEqual(self.call('/poll', {'binding': binding, 'busy': False}, token)[0], 200)
        self.assertEqual(self.call('/control', {'action': 'read', 'args': {}}, origin=None)[0], 403)
        key = self.service.state.control_key
        status, command = self.call('/control', {'action': 'read', 'args': {}}, key, origin=None)
        self.assertEqual(status, 200)
        status, response = self.call('/poll', {'binding': binding, 'busy': False}, token)
        self.assertEqual(response['command']['id'], command['id'])
        self.assertIsNone(self.call('/poll', {'binding': binding, 'busy': False}, token)[1]['command'])
        self.assertEqual(self.call('/result', {'id': command['id'], 'session': binding['session'], 'error': None}, token)[0], 200)
        self.assertEqual(self.call('/control', {'action': 'send_message', 'args': {}}, key, origin=None)[0], 400)
        self.assertEqual(self.call('/control', {'action': 'open_job', 'args': {'url': 'https://evil.example/'}}, key, origin=None)[0], 400)
        status, command = self.call('/control', {'action': 'scroll', 'args': {'y': 200}}, key, origin=None)
        self.assertEqual(status, 200)
        self.call('/poll', {'binding': binding, 'busy': False}, token)
        self.call('/poll', {'binding': None, 'busy': True}, token)
        self.assertEqual(self.call('/result', {'id': command['id'], 'session': binding['session'], 'error': None}, token)[0], 400)
        self.assertEqual(self.call('/poll', {'binding': binding, 'busy': False}, token)[0], 403)

    def test_browser_commands_version_stop_blocker_and_navigation_limits(self):
        token = self.pair()
        binding = {'tab_id': 12, 'session': '12345678-1234-1234-1234-123456789abc', 'url': 'https://www.zhipin.com/web/geek/jobs'}
        key = self.service.state.control_key
        self.call('/poll', {'binding': binding, 'busy': False}, token)
        self.assertEqual(self.call('/control', {'action': 'navigate', 'args': {'url': binding['url']}}, key, origin=None)[0], 400)
        self.call('/poll', {'binding': binding, 'busy': False, 'version': '0.4.0'}, token)
        for path in ['https://www.zhipin.com/logout/', 'https://www.zhipin.com/wapi/send', 'https://evil.example/']:
            self.assertEqual(self.call('/control', {'action': 'navigate', 'args': {'url': path}}, key, origin=None)[0], 400)
        self.assertEqual(self.call('/control', {'action': 'input', 'args': {'key': 'bad', 'ref': 'c0', 'value': 'AI'}}, key, origin=None)[0], 400)
        self.service.state.blocker = 'verification_required'
        self.assertEqual(self.call('/control', {'action': 'scroll', 'args': {'y': 200}}, key, origin=None)[0], 400)
        self.service.state.blocker = None
        self.assertEqual(self.call('/control', {'action': 'navigate', 'args': {'url': binding['url'] + '?query=AI&ka=tracking'}}, key, origin=None)[0], 200)
        command = next(iter(self.service.state.commands.values()))
        self.assertEqual(command['args']['url'], binding['url'] + '?query=AI')
        self.assertEqual(self.call('/control', {'action': 'stop', 'args': {}}, key, origin=None)[0], 200)
        self.assertEqual(command['status'], 'cancelled')
        self.assertIsNone(self.service.state.binding)


if __name__ == '__main__':
    unittest.main()
