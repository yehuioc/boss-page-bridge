"""有限职位浏览与本地候选整理。只复用浏览指令，不调用 Boss 私有接口。"""
from __future__ import annotations
import copy
import csv
import io
import json
import math
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode

DEFAULT_PROFILE = {'keywords': [], 'city': '全国', 'remote': False,
                   'part_time': False, 'education': '学历不限', 'experience_years': 0,
                   'filters': {}, 'limit': 12}
LEVELS = {'学历不限': 0, '初中及以下': 1, '中专': 2, '中技': 2, '中专/中技': 2,
          '高中': 2, '大专': 3, '本科': 4, '硕士': 5, '博士': 6}
LABELS = {'role': '岗位方向', 'remote': '远程', 'part_time': '兼职', 'education': '学历', 'experience': '经验'}
ASSESSMENT_VERSION = 2


def profile_value(raw):
    if not isinstance(raw, dict) or set(raw) - set(DEFAULT_PROFILE):
        raise ValueError('找岗条件结构无效')
    p = {**copy.deepcopy(DEFAULT_PROFILE), **raw}
    if (not isinstance(p['keywords'], list) or not 1 <= len(p['keywords']) <= 5
            or any(not isinstance(k, str) or not 1 <= len(k.strip()) <= 40 for k in p['keywords'])):
        raise ValueError('请填写1至5个关键词，每个不超过40字')
    p['keywords'] = list(dict.fromkeys(k.strip() for k in p['keywords']))
    if not isinstance(p['city'], str) or not re.fullmatch(r'[\u4e00-\u9fff]{2,10}', p['city']):
        raise ValueError('城市须为页面可选城市名称，或全国')
    if (type(p['remote']) is not bool or type(p['part_time']) is not bool
            or p['education'] not in LEVELS or type(p['experience_years']) is not int
            or not 0 <= p['experience_years'] <= 50 or type(p['limit']) is not int or not 1 <= p['limit'] <= 30):
        raise ValueError('个人条件或本轮数量无效')
    if (not isinstance(p['filters'], dict) or set(p['filters']) - {'salary', 'degree', 'experience', 'jobType'}
            or any(not isinstance(v, str) or not 1 <= len(v) <= 30 for v in p['filters'].values())):
        raise ValueError('网站筛选无效；请选择页面观察到的选项名称')
    return p


def _quote(line, match):
    start = max(0, match.start() - 80)
    return ('…' if start else '') + line[start:start + 240] + ('…' if start + 240 < len(line) else '')


def _evidence(text, positive, negative, neutral=None):
    yes, no = [], []
    for line in re.split(r'[\n。；;！!？?]', text):
        line = line.strip()
        if not line:
            continue
        # Blank out negated on-site phrases without changing quote positions.
        signal = re.sub(neutral, lambda m: ' ' * len(m[0]), line) if neutral else line
        rejected, accepted = re.search(negative, signal), re.search(positive, line)
        if rejected:
            no.append(_quote(line, rejected))
        elif accepted:
            yes.append(_quote(line, accepted))
    return {'state': 'conflict' if yes and no else 'no' if no else 'yes' if yes else 'unknown',
            'quotes': list(dict.fromkeys(no + yes))[:5]}


def assess(job, profile):
    """规则只整理明确证据；缺失、否定与矛盾均不能提升为符合。"""
    title = job.get('title') or ''
    text = title + '\n' + (job.get('description') or '')
    facts = {}
    hits = [k for k in profile['keywords'] if k in text]
    for keyword, pattern in {'线上运营': r'线上(?:兼职|内容|日常)?运营',
                             '账号运营': r'账号(?:孵化|内容|日常|维护)?运营'}.items():
        if keyword in profile['keywords'] and keyword not in hits:
            found = re.search(pattern, text)
            if found:
                hits.append(found[0])
    facts['role'] = {'state': 'yes' if hits else 'unknown', 'quotes': hits or [title]}
    facts['remote'] = _evidence(text,
        r'(?:远程|居家|在家|线上|在线)(?:办公|工作)|远程(?:线上)?兼职|居家兼职|(?:可|支持|接受|允许|提供)远程|全国可做|异地可做',
        r'(?:不|无法|不能|暂不)(?:支持|接受|提供|允许)?(?:远程|居家|在家)|(?:必须|需要|要求)(?:线下|到岗|到公司)|线下办公|坐班',
        neutral=r'(?:不需要|不要求|不必|无需|无须|不用|不)(?:到公司(?:坐班)?|线下(?:办公|工作|坐班)|坐班|到岗)|无固定坐班(?:时间)?')
    facts['part_time'] = _evidence(text,
        r'兼职|非全日制',
        r'(?:不招|不接受|不支持|拒绝|不考虑)兼职|(?:只招|仅招|必须|要求|需做)全职|全职(?:岗位|工作)[，,]?不')
    education = job.get('education')
    facts['education'] = {'state': 'unknown', 'quotes': []}
    if education in LEVELS:
        facts['education'] = {'state': 'yes' if LEVELS[education] <= LEVELS[profile['education']] else 'no', 'quotes': [education]}
    for line in text.splitlines():
        if re.search(r'(?:必须|要求|仅限|需具备|应具备).{0,12}(?:硕士|博士)', line) and LEVELS[profile['education']] < 5:
            facts['education'] = {'state': 'no', 'quotes': [education or '', line[:240]]}
    experience = job.get('experience') or ''
    years = re.search(r'(\d+)\s*(?:[-~至]\s*\d+年|年以上|年经验)', experience)
    facts['experience'] = {'state': 'unknown', 'quotes': [experience] if experience else []}
    if years:
        facts['experience']['state'] = 'yes' if int(years[1]) <= profile['experience_years'] else 'no'
    elif re.search(r'经验不限|无需经验|无经验|零经验', experience):
        facts['experience']['state'] = 'yes'
    # Header and body may disagree. Prefer explicit required years over a lenient header.
    for line in text.splitlines():
        needed = re.search(r'(\d+)\s*(?:年以上|年及以上|[-~至]\s*\d+年).{0,18}(?:工作|运营|相关|从业)?经验', line)
        if needed and int(needed[1]) > profile['experience_years'] and not re.search(r'优先|加分|不限|无经验|无需经验', line):
            facts['experience'] = {'state': 'no', 'quotes': [experience, line[:240]]}
        elif re.search(r'接受.{0,5}(?:无经验|零经验|小白)|无需.{0,4}经验|不限经验|经验不限', line) and facts['experience']['state'] == 'unknown':
            facts['experience'] = {'state': 'yes', 'quotes': [line[:240]]}
    required = ['role', 'education', 'experience']
    if profile['remote']:
        required.append('remote')
    if profile['part_time']:
        required.append('part_time')
    rejected = [k for k in required if facts[k]['state'] == 'no']
    uncertain = [k for k in required if facts[k]['state'] in ('unknown', 'conflict')]
    status = '不符合硬条件' if rejected else '待核对' if uncertain else '符合已核对条件'
    notes = []
    if job.get('salary_status') != 'dom_text':
        notes.append('薪资尚未从普通文字核对；本轮薪资不限，不据此剔除')
    if re.search(r'在校|应届|届毕业', text + experience):
        notes.append('含在校、届别或应届条件；当前资料不足以确认毕业身份')
        if status == '符合已核对条件':
            status = '待核对'
    if any('截断' in w for w in job.get('warnings', [])):
        notes.append('描述可能截断，不能据缺失部分认定符合')
        if status == '符合已核对条件':
            status = '待核对'
    return {'status': status, 'facts': facts, 'reasons': [LABELS[k] + '不符' for k in rejected] +
            [LABELS[k] + ('存在矛盾' if facts[k]['state'] == 'conflict' else '未明确') for k in uncertain], 'notes': notes}


def catalog(page):
    """兼容已安装0.5.3的观察信息，0.6使用独立的有界筛选目录。"""
    if page.get('browser', {}).get('filters'):
        return page['browser']['filters']
    result = []
    labels = {'求职类型': 'jobType', '薪资待遇': 'salary', '工作经验': 'experience', '学历要求': 'degree'}
    for c in page.get('browser', {}).get('controls', []):
        name = re.sub(r'\(\d+\)$', '', c['label'])
        if name not in labels:
            continue
        context = c.get('context', '')
        if context.startswith('experience_options='):
            opts = json.loads(context.split('=', 1)[1].split(' | ', 1)[0])
        elif context.startswith('['):
            opts = [{'label': o['label'], 'value': o['ka'].rsplit('-', 1)[-1]} for o in json.loads(context)]
        else:
            continue
        result.append({'key': labels[name], 'label': name, 'options': opts})
    return result


class Cancelled(Exception):
    pass


class SearchManager:
    """transport提供session()/command(action,args,cancel)/stop()，浏览与保存各一份实现。"""
    def __init__(self, directory, transport):
        self.directory = Path(directory) / 'search'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.transport = transport
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.thread = None
        self.current = self._load('latest.json') or {'profile': copy.deepcopy(DEFAULT_PROFILE), 'status': 'idle', 'candidates': {}, 'errors': []}
        if not (self.directory / 'library.json').exists() and self.current['candidates']:
            for candidate in self.current['candidates'].values():
                self._remember(candidate)
        if self.current['status'] in ('running', 'stopping'):
            self.current.update(status='paused', message='本机服务曾中断；保留已有候选，未自动续跑')
            self._save()
        changed = self._refresh(self.current['candidates'], self.current['profile'])
        if changed:
            self._save()
        library = self._load('library.json') or {}
        if self._refresh(library):
            self._write('library.json', library)

    def _refresh(self, candidates, profile=None):
        changed = False
        for c in candidates.values():
            original_profile = c.get('profile', profile)
            if original_profile and c.get('assessment_version') != ASSESSMENT_VERSION:
                c['assessment'] = assess(c['job'], original_profile)
                c['assessment_version'] = ASSESSMENT_VERSION
                c['assessed_at'] = time.time()
                changed = True
        return changed

    def _load(self, name):
        path = self.directory / name
        return json.loads(path.read_text('utf-8')) if path.exists() else None

    def _write(self, name, value):
        path = self.directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(path)

    def _save(self):
        with self.lock:
            self.current['updated_at'] = time.time()
            self._write('latest.json', self.current)
            if self.current.get('id'):
                self._write('runs/' + self.current['id'] + '.json', self.current)

    def _remember(self, candidate):
        library = self._load('library.json') or {}
        url = candidate['job']['url']
        previous = library.get(url, {})
        library[url] = {**candidate, 'profile': copy.deepcopy(self.current['profile']), 'run_id': self.current['id'],
                        'first_seen': previous.get('first_seen', candidate['read_at'])}
        self._write('library.json', library)

    def library(self):
        with self.lock:
            entries = self._load('library.json') or {}
            return {'id': 'library', 'profile': self.current['profile'], 'status': 'saved',
                    'message': '已存岗位按链接去重；每条判断依据其采集时条件，不代表当前仍在招聘。',
                    'updated_at': max((c['read_at'] for c in entries.values()), default=0),
                    'candidates': entries, 'errors': []}

    def view(self):
        with self.lock:
            return copy.deepcopy(self.current)

    def start(self, raw):
        p = profile_value(raw)
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError('已有找岗任务，请先停止或等待完成')
            acquire = getattr(self.transport, 'acquire', None)
            if acquire:
                acquire()
            try:
                session = self.transport.session()
            except Exception:
                release = getattr(self.transport, 'release', None)
                if release:
                    release()
                raise
            self.cancel.clear()
            self.current = {'id': secrets.token_hex(12), 'profile': p, 'session': session, 'status': 'running',
                            'started_at': time.time(), 'message': '正在读取筛选条件', 'candidates': {}, 'errors': [], 'discovery': []}
            self._save()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
            return self.view()

    def stop(self):
        self.cancel.set()
        self.transport.stop()
        with self.lock:
            if self.thread and self.thread.is_alive():
                self.current.update(status='stopping', message='已撤销浏览接管，正在保存已读候选')
                self._save()
            return self.view()

    def _check(self):
        if self.cancel.is_set():
            raise Cancelled('用户停止；未重发未完成操作')
        if time.time() - self.current['started_at'] > 900:
            raise Cancelled('本轮达到15分钟上限，保留已读结果')
        if self.transport.session() != self.current['session']:
            raise Cancelled('浏览页已停止或重新连接，本轮不跨会话续跑')

    def _command(self, action, args=None):
        self._check()
        page = self.transport.command(action, args or {}, self.cancel)
        self._check()
        return page

    def _progress(self, text):
        with self.lock:
            self.current['message'] = text
            self._save()

    def _city(self, page, city):
        root = next((c for c in page.get('browser', {}).get('controls', []) if c['label'].startswith('城市：')), None)
        if root and root['label'] == '城市：' + city and 'city' in parse_qs(urlsplit(page.get('navigation_url', '')).query):
            return page
        if not root:
            raise ValueError('未观察到城市入口，不猜城市编号')
        page = self._command('click', {'key': page['browser']['key'], 'ref': root['ref']})
        option = next((c for c in page['browser']['controls'] if c['kind'] == 'filter_option' and c['label'] == city and 'city-list' in c.get('context', '')), None)
        if not option:
            raise ValueError('当前可见城市选项未找到“' + city + '”；请在 Boss 选定城市再运行')
        page = self._command('click', {'key': page['browser']['key'], 'ref': option['ref']})
        if not any(c['label'] == '城市：' + city for c in page['browser']['controls']):
            raise ValueError('城市标签没有切换，未认定筛选成功')
        return page

    def _run(self):
        try:
            p = self.current['profile']
            page = self._command('navigate', {'url': 'https://www.zhipin.com/web/geek/jobs'})
            page = self._city(page, p['city'])
            values = {}
            available = catalog(page)
            for key, label in p['filters'].items():
                group = next((f for f in available if f['key'] == key), None)
                choice = next((o for o in (group or {}).get('options', []) if o['label'] == label), None)
                if not choice:
                    raise ValueError('当前页面没有观察到筛选：' + key + '=' + label)
                if choice['value'] != '0':
                    values[key] = choice['value']
            city_params = parse_qs(urlsplit(page.get('navigation_url', page['url'])).query)
            if 'city' not in city_params:
                raise ValueError('城市已显示，但未观察到可保留的城市网址，未猜测全国编号')
            values['city'] = city_params['city'][0]
            queue = {}
            quota = math.ceil(p['limit'] / len(p['keywords']))
            for keyword in p['keywords']:
                self._progress('搜索：' + keyword)
                url = 'https://www.zhipin.com/web/geek/jobs?' + urlencode({'query': keyword, **values})
                page = self._command('navigate', {'url': url})
                actual = parse_qs(urlsplit(page['navigation_url']).query)
                if any(actual.get(k, [''])[0] != str(v) for k, v in {'query': keyword, **values}.items()):
                    raise ValueError('搜索或筛选网址未保持，未收录结果')
                # Root selected labels are independent of the URL; check nonzero filters.
                for group in available:
                    if group['key'] in values and not any(c['label'] == group['label'] + '(1)' for c in page['browser']['controls']):
                        raise ValueError('页面未显示已选择的' + group['label'] + '；兼职页面不使用全职薪资档位，请移除该筛选后重开本轮')
                found = set()
                stalled = 0
                rounds = 0
                while rounds <= 4:
                    before = len(found)
                    for link in page.get('jobs', []):
                        if not re.fullmatch(r'https://www\.zhipin\.com/job_detail/[^/]+\.html', link['url']):
                            continue
                        found.add(link['url'])
                        record = queue.setdefault(link['url'], {'url': link['url'], 'title': link['text'], 'sources': []})
                        source = {'keyword': keyword, 'search_url': url, 'captured_at': page['captured_at']}
                        if not any(s['keyword'] == keyword for s in record['sources']):
                            record['sources'].append(source)
                    if len(found) >= quota:
                        break
                    stalled = stalled + 1 if len(found) == before else 0
                    if stalled >= 2:
                        break
                    if rounds >= 4:
                        break
                    page = self._command('scroll', {'y': 1200, 'target': 'list'})
                    rounds += 1
                self.current['discovery'].append({'keyword': keyword, 'url': url, 'observed': len(found),
                                                  'scroll_rounds': rounds, 'stopped': '本轮额度' if len(found) >= quota else '无新职位或滚动上限'})
                self._save()
            # Round-robin keywords; a long first list must not consume the entire allowance.
            selected = []
            pools = [[r for r in queue.values() if any(s['keyword'] == k for s in r['sources'])] for k in p['keywords']]
            seen = set()
            while len(selected) < p['limit'] and any(pools):
                for pool in pools:
                    while pool and pool[0]['url'] in seen:
                        pool.pop(0)
                    if pool and len(selected) < p['limit']:
                        record = pool.pop(0)
                        seen.add(record['url'])
                        selected.append(record)
            for i, item in enumerate(selected):
                self._progress('读取详情：' + str(i + 1) + '/' + str(len(selected)) + ' ' + item['title'])
                detail = self._command('open_job', {'url': item['url']})
                job = detail.get('job')
                if not job or job.get('url') != item['url'] or job.get('layout') != 'detail_page':
                    self.current['errors'].append({'url': item['url'], 'reason': '详情未能核对或职位已关闭，未作为候选'})
                    self._save()
                    self._command('back')
                    continue
                candidate = {'job': job, 'sources': item['sources'], 'assessment': assess(job, p),
                             'capture': detail.get('_capture'), 'read_at': time.time(),
                             'assessment_version': ASSESSMENT_VERSION, 'assessed_at': time.time()}
                with self.lock:
                    self.current['candidates'][job['url']] = candidate
                    self._remember(candidate)
                    self._save()
                # Return to this keyword's exact filters, not a generic homepage.
                returned = self._command('back')
                if '/web/geek/jobs' not in returned.get('navigation_url', ''):
                    raise ValueError('返回未回到职位列表，停止以免继续错页')
            self._check()
            self.current.update(status='done', message='本轮已完成；结果只覆盖已加载并核对的职位，不代表全站。未发送消息或投递。')
        except Cancelled as error:
            self.current.update(status='paused', message=str(error))
        except Exception as error:
            self.current.update(status='paused', message='浏览已暂停：' + str(error))
        finally:
            self.current['ended_at'] = time.time()
            self._save()
            release = getattr(self.transport, 'release', None)
            if release:
                release()
            if self.current['status'] == 'done' and self.current['candidates'] and getattr(self, 'on_complete', None):
                try:
                    self.on_complete(self.view())
                    self.current['model_message'] = '所选本轮岗位已进入模型阅读；模型结果独立显示，不以规则替代'
                except Exception as error:
                    self.current['model_message'] = '模型阅读未启动：' + str(error)
                self._save()

    def export(self, kind, run_id=None):
        if run_id is not None:
            if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9]{24}', run_id):
                raise ValueError('保存的任务编号无效')
            with self.lock:
                data = self._load('runs/' + run_id + '.json')
            if data is None:
                raise ValueError('没有找到保存的这轮任务')
        else:
            data = self.view()
        # Re-evaluate saved observations with current rules; do not change source evidence.
        self._refresh(data['candidates'], data['profile'])
        if getattr(self, 'decorate', None):
            data = self.decorate(data)
        if kind == 'json':
            return json.dumps(data, ensure_ascii=False, indent=2)
        candidates = sorted(data['candidates'].values(), key=lambda c: {'符合已核对条件': 0, '待核对': 1, '不符合硬条件': 2}[c['assessment']['status']])
        if kind == 'csv':
            stream = io.StringIO(newline='')
            writer = csv.writer(stream)
            writer.writerow(['判断', '职位', '公司', '薪资', '地址', '原因', '链接', '模型理解', '模型未知项'])
            for c in candidates:
                job, a = c['job'], c['assessment']
                ai = c.get('ai') if not c.get('ai', {}).get('stale') else None
                row = [ai['label'] if ai else '规则辅助：' + a['status'], job['title'], job.get('company') or '', job.get('salary') or '待核对', job.get('location') or '', ai['reason'] if ai else '；'.join(a['reasons']), job['url'], ai['summary'] if ai else '', '；'.join(ai['unknowns']) if ai else '']
                writer.writerow(["'" + v if v.lstrip().startswith(('=', '+', '-', '@')) else v for v in row])
            return '\ufeff' + stream.getvalue()
        if kind != 'md':
            raise ValueError('导出仅支持md、csv、json')
        lines = ['# 职位候选核对', '', data.get('message', ''), '', '条件：' + json.dumps(data['profile'], ensure_ascii=False), '']
        for c in candidates:
            job, a = c['job'], c['assessment']
            lines += ['## ' + job['title'], '', a['status'] + ' · ' + (job.get('company') or '公司待核对') + ' · ' + (job.get('salary') or '薪资待核对'), '', job['url'], '']
            if c.get('ai'):
                ai = c['ai']
                lines += ['### 模型阅读' + ('（JD已变化，须重新分析）' if ai.get('stale') else ''), '', ai['label'], '', ai['summary'], '', ai['reason'], '', '分析条件：' + json.dumps(ai['profile'], ensure_ascii=False), '']
                lines += ['- ' + ('HR回复' if e['source'] == 'hr' else 'JD') + '：' + e['quote'] + '；' + e['meaning'] for e in ai['evidence']]
                lines += ['', '仍待核对：' + '；'.join(ai['unknowns']), '建议问询（未发送）：' + '；'.join(ai['questions']), '', '### 规则辅助', '']
            for key, fact in a['facts'].items():
                lines.append('- ' + LABELS[key] + '：' + {'yes': '有依据', 'no': '不符', 'unknown': '待核对', 'conflict': '有矛盾'}[fact['state']] + '；' + ' / '.join(fact['quotes']))
            lines += ['', '；'.join(a['notes']), '', '采集：' + job['captured_at'], '来源：' + '、'.join(s['keyword'] for s in c['sources']), '本机证据：' + str(c.get('capture') or '见本轮保存的职位原文'), '', '### 职位原文', '', job.get('description') or '未提取', '']
        return '\n'.join(lines)
