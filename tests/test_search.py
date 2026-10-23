import copy
import tempfile
import threading
import time
import unittest
from pathlib import Path
from job_search import SearchManager, assess, profile_value

# Entirely synthetic test profile; not an account or a runtime default.
DEFAULT_PROFILE = {"keywords":["账号运营","内容运营"],"city":"全国","remote":True,"part_time":True,"education":"大专","experience_years":2,"filters":{},"limit":12}


def job(**values):
    return {'url': 'https://www.zhipin.com/job_detail/a.html', 'layout': 'detail_page',
            'title': '账号运营', 'company': '合成测试公司', 'salary': '100元/天',
            'salary_status': 'dom_text', 'education': '高中', 'experience': '经验不限',
            'description': '可远程办公，接受兼职。无需经验，负责账号运营。',
            'warnings': [], 'captured_at': '2020-01-01T00:00:00Z', **values}


class EvidenceTests(unittest.TestCase):
    def test_public_install_has_no_personal_profile_or_automatic_model_request(self):
        from job_search import DEFAULT_PROFILE as installation
        import json
        self.assertEqual(installation['keywords'], [])
        self.assertFalse(installation['remote']); self.assertFalse(installation['part_time'])
        self.assertEqual(installation['education'], '学历不限')
        with self.assertRaises(ValueError):
            profile_value({})
        example = json.loads((Path(__file__).resolve().parents[1]/'examples/search-profile.example.json').read_text('utf-8'))
        self.assertEqual(profile_value(example)['keywords'], ['示例工程师', '示例设计师'])

    def test_online_title_never_establishes_remote_or_part_time(self):
        result = assess(job(title='线上运营', description='负责用户沟通和日常运营。'), DEFAULT_PROFILE)
        self.assertEqual(result['status'], '待核对')
        self.assertEqual(result['facts']['remote']['state'], 'unknown')
        self.assertEqual(result['facts']['part_time']['state'], 'unknown')
        flexible = assess(job(description='负责账号运营，可远程办公，时间灵活。'),DEFAULT_PROFILE)
        self.assertEqual(flexible['facts']['part_time']['state'],'unknown')

    def test_negative_conflicting_and_experience_requirements_never_pass(self):
        for description in ['不支持远程，接受兼职。', '可远程办公。要求线下到岗，接受兼职。',
                            '可远程办公。不接受兼职。', '可远程办公，接受兼职。要求3年以上运营经验。']:
            with self.subTest(description=description):
                self.assertNotEqual(assess(job(description=description), DEFAULT_PROFILE)['status'], '符合已核对条件')
        conflict = assess(job(description='支持远程办公。必须到岗办公。接受兼职。'), DEFAULT_PROFILE)
        self.assertEqual(conflict['facts']['remote']['state'], 'conflict')
        self.assertTrue(conflict['facts']['remote']['quotes'])

    def test_lower_education_and_no_experience_are_eligible_without_false_student_claim(self):
        self.assertEqual(assess(job(), DEFAULT_PROFILE)['status'], '符合已核对条件')
        self.assertEqual(assess(job(education='硕士'), DEFAULT_PROFILE)['status'], '不符合硬条件')
        self.assertEqual(assess(job(experience='3-5年'), DEFAULT_PROFILE)['status'], '不符合硬条件')
        self.assertEqual(assess(job(experience='应届生'), DEFAULT_PROFILE)['status'], '待核对')
        self.assertEqual(assess(job(description='可远程办公，接受兼职。仅限2027届毕业生，负责账号运营。'), DEFAULT_PROFILE)['status'], '待核对')

    def test_profile_validation_does_not_allow_arbitrary_commands_or_expansive_runs(self):
        for change in [{'limit': 31}, {'limit': True}, {'keywords': []}, {'filters': {'script': 'send'}},
                       {'remote': 'true'}, {'city': 'https://evil.example'}, {'unknown': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                profile_value(change)

    def test_negated_on_site_phrases_are_not_remote_conflicts_but_real_requirements_still_fail(self):
        for phrase in ['不需要坐班','无固定坐班时间','无需线下办公','不用到公司坐班']:
            with self.subTest(phrase=phrase):
                result=assess(job(description='接受居家办公，兼职账号运营。'+phrase),DEFAULT_PROFILE)
                self.assertEqual(result['facts']['remote']['state'],'yes')
        result=assess(job(description='接受居家办公，兼职账号运营。无需坐班，但必须到公司面谈后线下办公。'),DEFAULT_PROFILE)
        self.assertNotEqual(result['facts']['remote']['state'],'yes')
        self.assertEqual(assess(job(title='线上兼职运营'),{**DEFAULT_PROFILE,'keywords':['线上运营']})['facts']['role']['state'],'yes')

    def test_long_line_quote_contains_the_actual_deciding_phrase(self):
        result=assess(job(description='资料说明'*100+'不接受居家办公，兼职账号运营。'),DEFAULT_PROFILE)
        self.assertIn('不接受居家',result['facts']['remote']['quotes'][0])


class Fake:
    def __init__(self):
        self.calls = []
        self.sid = 'same-session'
        self.url = 'https://www.zhipin.com/web/geek/jobs?city=100010000'
        self.history = []
        self.hold = None
        self.release_count = 0
        self.missing = False

    def acquire(self):
        pass

    def release(self):
        self.release_count += 1

    def session(self):
        return self.sid

    def stop(self):
        self.sid = None

    def command(self, action, args, cancel):
        self.calls.append((action, args))
        if self.hold:
            self.hold.set()
            cancel.wait(2)
            from job_search import Cancelled
            raise Cancelled('test stop')
        if action in ('navigate', 'open_job'):
            self.history.append(self.url)
            self.url = args['url']
        elif action == 'back':
            self.url = self.history.pop()
        if '/job_detail/' in self.url:
            return {'url': self.url, 'navigation_url': self.url, '_capture': 'captures/test.json',
                    'job': None if self.missing else job(url=self.url)}
        return {'url': self.url.split('?')[0], 'navigation_url': self.url if '?' in self.url else self.url + '?city=100010000',
                'captured_at': 'test', 'browser': {'key': 'test', 'controls': [{'label': '城市：全国'}]},
                'jobs': [{'text': '账号运营', 'url': 'https://www.zhipin.com/job_detail/a.html'},
                         {'text': '账号运营', 'url': 'https://www.zhipin.com/job_detail/b.html'}]}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        private = Path(__file__).resolve().parents[1] / 'private'
        private.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=private)
        self.fake = Fake()
        self.manager = SearchManager(self.temp.name, self.fake)

    def tearDown(self):
        if self.manager.thread and self.manager.thread.is_alive():
            self.manager.stop()
            self.manager.thread.join(3)
        self.temp.cleanup()

    def test_two_keywords_deduplicate_same_jobs_keep_sources_and_restore_list(self):
        self.manager.start({**DEFAULT_PROFILE,'limit': 4})
        self.manager.thread.join(3)
        run = self.manager.view()
        self.assertEqual(run['status'], 'done', run['message'])
        self.assertEqual(len(run['candidates']), 2)
        self.assertEqual(len(next(iter(run['candidates'].values()))['sources']), 2)
        self.assertEqual(sum(a == 'open_job' for a, _ in self.fake.calls), 2)
        self.assertTrue(self.fake.url.startswith('https://www.zhipin.com/web/geek/jobs?'))
        restarted = SearchManager(self.temp.name, self.fake)
        self.assertEqual(restarted.view()['candidates'], run['candidates'])
        self.assertIn('可远程办公', restarted.export('md'))
        self.assertEqual(self.fake.release_count, 1)
        saved_id=run['id']
        self.manager.start({**DEFAULT_PROFILE,'limit':2,'remote':False})
        self.manager.thread.join(3)
        library=self.manager.library()
        self.assertEqual(len(library['candidates']),2)
        self.assertFalse(next(iter(library['candidates'].values()))['profile']['remote'])
        self.assertIn('可远程办公',self.manager.export('md',saved_id))
        with self.assertRaises(ValueError):self.manager.export('md','../private')

    def test_missing_details_are_not_saved_and_return_is_still_performed(self):
        self.fake.missing = True
        self.manager.start({**DEFAULT_PROFILE,'limit': 2})
        self.manager.thread.join(3)
        run = self.manager.view()
        self.assertEqual(run['status'], 'done')
        self.assertEqual(run['candidates'], {})
        self.assertEqual(len(run['errors']), 2)
        self.assertEqual(sum(a == 'back' for a, _ in self.fake.calls), 2)

    def test_duplicate_start_stop_and_restart_do_not_replay(self):
        self.fake.hold = threading.Event()
        self.manager.start(DEFAULT_PROFILE)
        self.assertTrue(self.fake.hold.wait(2))
        with self.assertRaises(ValueError):
            self.manager.start(DEFAULT_PROFILE)
        self.manager.stop()
        self.manager.thread.join(3)
        self.assertEqual(self.manager.view()['status'], 'paused')
        restarted = SearchManager(self.temp.name, self.fake)
        self.assertIsNone(restarted.thread)
        self.assertEqual(len(self.fake.calls), 1)

    def test_csv_formula_is_escaped_and_complete_json_source_retained(self):
        c = {'job': job(title='=HYPERLINK("bad")'), 'assessment': assess(job(), DEFAULT_PROFILE), 'sources': []}
        self.manager.current['candidates'] = {'a': c}
        self.assertIn("'=HYPERLINK", self.manager.export('csv'))
        self.assertIn('可远程办公', self.manager.export('json'))

    def test_restart_reassesses_saved_library_using_its_original_profile_without_changing_source(self):
        original=job(description='接受居家办公，账号运营兼职，不需要坐班。')
        candidate={'job':copy.deepcopy(original),'profile':copy.deepcopy(DEFAULT_PROFILE),'assessment':{'status':'待核对'},'read_at':1}
        self.manager._write('library.json',{'a':candidate})
        restarted=SearchManager(self.temp.name,self.fake)
        saved=restarted.library()['candidates']['a']
        self.assertEqual(saved['assessment']['facts']['remote']['state'],'yes')
        self.assertEqual(saved['job'],original)
        self.assertEqual(saved['profile'],DEFAULT_PROFILE)
        self.assertEqual(saved['assessment_version'],2)


if __name__ == '__main__':
    unittest.main()
