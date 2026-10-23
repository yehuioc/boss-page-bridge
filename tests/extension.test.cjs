// All DOM, salary, names and text below are synthetic test fixtures.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const extension = path.join(__dirname, '../extension');
const source = fs.readFileSync(path.join(extension, 'read-page.js'), 'utf8');
const extractor = fs.readFileSync(path.join(extension, 'extract-job.js'), 'utf8');

function read({url = 'https://www.zhipin.com/web/geek/jobs?secret=never', text = '职位：工程师', links = [], frames = 0} = {}) {
  const document = {title: '合成 Boss 页面', body: {innerText: text}, readyState: 'complete',
    querySelectorAll: selector => selector === 'iframe' ? new Array(frames) : links};
  const context = vm.createContext({URL, location: {href: url}, document, innerHeight: 800, innerWidth: 1200, scrollX: 0, scrollY: 0, Date});
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(vm.runInContext('readBossPage()', context)));
}

test('DOM text does not require console or page JS variables', () => {
  const result = read({frames: 2});
  assert.equal(result.text, '职位：工程师');
  assert.equal(result.url, 'https://www.zhipin.com/web/geek/jobs');
  assert.equal(result.frames, 2);
  assert.equal(result.scope, 'top_frame_rendered_dom');
});

test('empty page is represented as empty; large rendered text is explicitly truncated', () => {
  assert.equal(read({text: ''}).text, '');
  const result = read({text: '职'.repeat(41000)});
  assert.equal(result.text.length, 40000);
  assert.equal(result.truncated, true);
});
test('chat fallback never copies the whole contact list or draft from document.body',()=>{
  const result=read({url:'https://www.zhipin.com/web/geek/chat',text:'其他HR联系人和未批准的私人草稿'});
  assert.equal(result.text,'消息页：尚未选中会话');
  assert.doesNotMatch(result.text,/私人草稿|其他HR/);
});

test('rejects foreign domains and HTTP before reading page content', () => {
  for (const url of ['https://www.zhipin.com.evil.example/', 'http://www.zhipin.com/', 'https://evil.example/']) {
    assert.throws(() => read({url}), /只读取/);
  }
});

test('links are limited to viewport and Boss, query values are removed', () => {
  const link = (href, top) => ({href, innerText: '职位', getBoundingClientRect: () => ({width: 50, height: 20, top, bottom: top + 20, left: 0, right: 50})});
  const result = read({links: [link('https://www.zhipin.com/job_detail/a.html?secret=x', 20),
    link('https://evil.example/', 40), link('https://www.zhipin.com/job_detail/b.html', 1000)]});
  assert.deepEqual(result.links, [{text: '职位', url: 'https://www.zhipin.com/job_detail/a.html'}]);
});
test('search candidates exclude related links outside real job cards',()=>{
  const link=(id,card)=>({href:'https://www.zhipin.com/job_detail/'+id+'.html',innerText:'岗位'+id,
    closest:()=>card?{}:null,getBoundingClientRect:()=>({width:20,height:20,top:20,bottom:40,left:0,right:20})});
  const page=read({links:[link('listed',true),link('recommended',false)]});
  assert.deepEqual(page.jobs.map(j=>j.url),['https://www.zhipin.com/job_detail/listed.html']);
});

test('manifest limits persistent access to Boss and loopback; no debugger or automatic content scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'sidePanel', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:8926/*', 'https://www.zhipin.com/*', 'https://zhipin.com/*']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'popup.html');
  assert.equal(manifest.content_scripts, undefined);
  const popup = fs.readFileSync(path.join(extension, 'popup.js'), 'utf8');
  assert.match(fs.readFileSync(path.join(extension, 'executor.js'), 'utf8'), /world: 'ISOLATED'/);
  assert.doesNotMatch(popup + source, /chrome\.debugger|connectOverCDP|playwright|document\.cookie|localStorage|\.click\(|dispatchEvent|world: 'MAIN'/);
});

test('panel is only a view and forwards binding, read and immediate stop to the single worker', async () => {
  const elements = Object.fromEntries(['code','connect','ping','bind','stop','read','focus','connection','status','summary','preview','salary-image'].map(id=>[id,{value:'',removeAttribute(){}}]));
  const calls = [], listeners = [];
  const state = {paired:true,binding:{tab_id:12},busy:false,message:'后台连接',snapshot:null};
  const context = vm.createContext({document:{getElementById:id=>elements[id]},chrome:{runtime:{
    connect:()=>({onMessage:{addListener:fn=>listeners.push(fn)},onDisconnect:{addListener(){}}}),
    sendMessage:async request=>{calls.push(request);return {result:state};}
  }}});
  vm.runInContext(fs.readFileSync(path.join(extension,'popup.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  await elements.bind.onclick();await elements.read.onclick();await elements.stop.onclick();
  assert.deepEqual(calls.map(c=>c.action),['state','bind','read','stop']);
  assert.match(elements.connection.textContent,/关闭侧栏仍可继续/);
  listeners[0]({...state,busy:true});
  assert.equal(elements.read.disabled,true);assert.notEqual(elements.stop.disabled,true);
  listeners[0]({...state,binding:null,snapshot:{title:'保留结果',url:'https://www.zhipin.com/',text:'old'}});
  assert.match(elements.summary.textContent,/上次读取（接管已停止/);
  assert.doesNotMatch(fs.readFileSync(path.join(extension,'popup.js'),'utf8'),/fetch\(|executeScript|setInterval|setTimeout|storage\./);
});

test('side panel submits personal criteria separately from platform filters and safely renders evidence',async()=>{
  class Element {
    constructor(tag='DIV'){this.tagName=tag;this.children=[];this.dataset={};this.value='';}
    append(child){this.children.push(child);}
    replaceChildren(){this.children=[];}
    removeAttribute(){}
    querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tagName.toLowerCase()===tag?[c]:[]),...c.querySelectorAll(tag)]);}
  }
  const html=fs.readFileSync(path.join(extension,'popup.html'),'utf8');
  const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const profile={keywords:['示例工程师','示例设计师'],city:'全国',remote:true,part_time:true,education:'本科',experience_years:0,limit:12,filters:{}};
  const candidate={job:{title:'<script>不要执行</script>',url:'https://www.zhipin.com/job_detail/a.html',captured_at:'now'},
    assessment:{status:'待核对',reasons:['远程未明确'],notes:[],facts:{remote:{state:'unknown',quotes:['岗位未说明']}}}};
  const state={paired:true,binding:{tab_id:12},busy:false,message:'ready',snapshot:null,
    search:{filters:[{key:'degree',label:'学历要求',options:[{label:'不限',value:'0'},{label:'本科',value:'203'}]}],
      run:{id:'run',profile,status:'done',message:'已保存',updated_at:1,candidates:{a:candidate}}}};
  const calls=[];
  const context=vm.createContext({document:{getElementById:id=>elements[id],createElement:tag=>new Element(tag)},Blob,
    URL:{createObjectURL:()=> 'blob:local-export',revokeObjectURL(){}},chrome:{runtime:{
      connect:()=>({onMessage:{addListener(){}},onDisconnect:{addListener(){}}}),sendMessage:async r=>{
        calls.push(r);return {result:r.action==='search_export'?{text:'本机报告'}:state};}}}});
  vm.runInContext(fs.readFileSync(path.join(extension,'popup.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements['search-results'].children[0].querySelectorAll('h3')[0].textContent,'<script>不要执行</script>');
  elements.keywords.value='示例工程师，示例设计师';elements.city.value='全国';elements.education.value='硕士';
  elements.years.value='3';elements.limit.value='12';elements.remote.checked=true;elements['part-time'].checked=true;
  await elements['search-form'].onsubmit({preventDefault(){}});
  const request=calls.find(c=>c.action==='search_start');assert.ok(request);
  assert.equal(request.args.experience_years,3);assert.equal(request.args.remote,true);
  assert.equal(Object.keys(request.args.filters).length,0,'a bachelors degree must not implicitly select only bachelors jobs');
  await elements['export-md'].onclick();assert.equal(elements['export-download'].href,'blob:local-export');
  assert.equal(elements['export-download'].download,'Boss候选核对.md');
});

test('timed-out page reads reject and cannot substitute late results', async () => {
  let timerCallback;
  const dummy = {value: '', textContent: ''};
  const context = vm.createContext({URL, AbortSignal,
    setTimeout: callback => {timerCallback = callback; return 1;}, clearTimeout: () => {},
    document: {getElementById: () => dummy},
    chrome: {storage: {local: {get: async () => ({})}}},
  });
  vm.runInContext(fs.readFileSync(path.join(extension, 'reader.js'), 'utf8'), context);
  let resolveLate;
  context.pending = new Promise(resolve => {resolveLate = resolve;});
  const operation = vm.runInContext('boundedRead(pending)', context);
  timerCallback();
  await assert.rejects(operation, /超过5秒/);
  resolveLate([{result: {text: 'late'}}]);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(operation, /超过5秒/);
});

function extract(page) {
  const context = vm.createContext({page});
  vm.runInContext(extractor, context);
  return JSON.parse(JSON.stringify(vm.runInContext('extractBossJob(page)', context)));
}

test('extracts independent job without recommendations and keeps bonus requirements', () => {
  const result = extract({url: 'https://www.zhipin.com/job_detail/example.html', title: '「工程师招聘」_合成公司招聘-BOSS直聘',
    text: '首页\n工程师 8-10K\n示例市 5-10年 本科\n职位描述\n岗位职责：\n1、负责项目\n任职要求：\n1、会沟通\n加分项\n英语\n测试女士\n招聘者\n看过该职位的人还看了\n销售 20K', links: [], truncated: false, captured_at: 'now'});
  assert.equal(result.title, '工程师');
  assert.equal(result.company, '合成公司');
  assert.equal(result.salary, '8-10K');
  assert.equal(result.location, '示例市');
  assert.equal(result.experience, '5-10年');
  assert.equal(result.education, '本科');
  assert.match(result.requirements, /加分项\n英语/);
  assert.doesNotMatch(result.description, /销售|招聘者|测试女士/);
});

test('list extraction follows selected detail URL instead of first job, and never guesses font digits', () => {
  const selected = 'https://www.zhipin.com/job_detail/b.html';
  const result = extract({url: 'https://www.zhipin.com/web/geek/jobs', title: '示例市招聘', captured_at: 'now', truncated: false,
    links: [{text: '高薪销售', url: 'https://www.zhipin.com/job_detail/a.html'},
      {text: '工程师', url: selected}, {text: '合成公司', url: 'https://www.zhipin.com/gongsi/a.html'}, {text: '查看更多信息', url: selected}],
    text: '高薪销售\n20-30K\n工程师\n\uE039-\uE032\uE031K·\uE032\uE035薪\n工程师\n\uE039-\uE032\uE031K·\uE032\uE035薪\n示例市\n3-5年\n大专\n职位描述\n岗位职责：\n维护森林\n任职要求：\n林业专业\n测试女士\n在线'});
  assert.equal(result.url, selected);
  assert.equal(result.company, '合成公司');
  assert.equal(result.salary, null);
  assert.equal(result.salary_status, 'needs_visual_review');
  assert.equal(result.duties, '维护森林');
  assert.equal(result.requirements, '林业专业');
  assert.doesNotMatch(result.description, /高薪销售/);
});

test('standalone headings split real description shape and recruiter activity is bounded by company', () => {
  const page = {url: 'https://www.zhipin.com/job_detail/example.html', title: '「项目管理岗招聘」_合成公司招聘-BOSS直聘',
    text: '项目管理岗\n6-8K·12薪\n示例市\n应届生\n本科\n职位描述\n岗位职责\n1. 合成测试项目\n\n任职要求\n1. 本科\n工作地点：示例市\n\n测试招聘员\n在线\n合成公司 · 主任\n去App\n工作地址\n地址', links: []};
  const result = extract(page);
  assert.equal(result.duties, '1. 合成测试项目');
  assert.equal(result.requirements, '1. 本科\n工作地点：示例市');
  assert.doesNotMatch(result.description, /测试招聘员|去App|主任/);
  assert.ok(!result.warnings.some(w => w.includes('未分段')));
  const prose = extract({...page, text: page.text.replace('岗位职责\n1. 合成测试项目', '介绍岗位职责以及工作内容\n1. 合成测试项目')});
  assert.equal(prose.duties, null, 'a phrase inside prose is not a section heading');
  const differentCompany = extract({...page, text: page.text.replace('合成公司 · 主任', '别的公司 · 主任')});
  assert.match(differentCompany.description, /测试招聘员/, 'activity alone must not discard description text');
});

test('selected identity can be outside viewport; unidentifiable page is not presented as a job', () => {
  const page = {url: 'https://www.zhipin.com/web/geek/jobs', title: '示例市招聘', links: [],
    selected_detail: {url: 'https://www.zhipin.com/job_detail/a.html', title: '工程师', company: '合成公司'},
    text: '工程师\n8-10K\n示例市 经验不限 本科\n职位描述\n维护设备', captured_at: 'now'};
  assert.equal(extract(page).title, '工程师');
  assert.equal(extract({...page, selected_detail: null}), null);
});

test('salary capture crops selected region at device scale and rejects changed tabs or changed page', async () => {
  let currentId = 12, afterText = 'same', captured = 0, drawn;
  const page = {url: 'https://www.zhipin.com/web/geek/jobs', text: 'same', captured_at: 'now',
    viewport: {width: 2048, height: 1080, scroll_x: 0, scroll_y: 0},
    salary_regions: [{text: '\uE039-\uE032K', x: 700, y: 20, width: 100, height: 28},
      {text: '\uE039-\uE032K', x: 1100, y: 200, width: 150, height: 28}]};
  const context = vm.createContext({URL, AbortSignal, setTimeout, clearTimeout,
    Image: class {naturalWidth = 4096; naturalHeight = 2160; async decode() {}},
    document: {getElementById: () => ({}), createElement: () => ({getContext: () => ({drawImage: (...args) => {drawn = args.slice(1);}}), toDataURL: () => 'cropped-only'})},
    chrome: {storage: {local: {get: async () => ({})}},
      tabs: {query: async () => [{id: currentId, url: page.url}], captureVisibleTab: async () => {captured++; return 'full-image-never-sent';}},
      scripting: {executeScript: async () => [{result: {...page, text: afterText}}]}},
    readBossPage: () => {}, page, tab: {id: 12, url: page.url, windowId: 1},
    job: {url: 'https://www.zhipin.com/job_detail/a.html', salary_raw: '\uE039-\uE032K'},
  });
  vm.runInContext(fs.readFileSync(path.join(extension, 'reader.js'), 'utf8'), context);
  const result = await vm.runInContext('captureSalary(tab, page, job)', context);
  assert.equal(result.data_url, 'cropped-only');
  assert.deepEqual(drawn.slice(0, 4), [2194, 394, 312, 68]);
  currentId = 99;
  await assert.rejects(vm.runInContext('captureSalary(tab, page, job)', context), /标签页或地址已改变/);
  assert.equal(captured, 1);
  currentId = 12; afterText = 'changed';
  await assert.rejects(vm.runInContext('captureSalary(tab, page, job)', context), /页面内容或位置改变/);
});

test('salary observation combines split glyph nodes and deduplicates the region', () => {
  const salary = '\uE039-\uE032\uE031K·\uE032\uE035薪';
  const parent = {innerText: salary};
  const nodes = [{textContent: '\uE039', parentElement: parent}, {textContent: '\uE032\uE031', parentElement: parent}];
  let index = 0;
  const rect = {left: 600, top: 120, right: 760, bottom: 150, width: 160, height: 30};
  const context = vm.createContext({URL, Date, NodeFilter: {SHOW_TEXT: 4}, innerHeight: 800, innerWidth: 1200, scrollX: 0, scrollY: 0,
    location: {href: 'https://www.zhipin.com/web/geek/jobs'}, getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    document: {title: '合成列表', body: {innerText: salary}, readyState: 'complete', querySelectorAll: () => [],
      createTreeWalker: () => ({nextNode: () => nodes[index++] || null}),
      createRange: () => ({selectNodeContents: () => {}, getBoundingClientRect: () => rect})}});
  vm.runInContext(source, context);
  const page = JSON.parse(JSON.stringify(vm.runInContext('readBossPage()', context)));
  assert.equal(page.salary_regions.length, 1);
  assert.equal(page.salary_regions[0].text, salary);
  assert.equal(page.salary_regions[0].x, 600);
});

test('worker salary crop needs no DOM and skips minimized windows without taking a screenshot', async () => {
  let minimized = true, captured = 0, closed = false;
  const page = {url:'https://www.zhipin.com/web/geek/jobs',text:'same',captured_at:'now',
    viewport:{width:1000,height:600,scroll_x:0,scroll_y:0},salary_regions:[{text:'\uE039K',x:600,y:100,width:100,height:28}]};
  const context=vm.createContext({URL,Blob,Uint8Array,atob,btoa,setTimeout,clearTimeout,
    createImageBitmap:async blob=>{assert.equal(await blob.text(),'full-viewport');return {width:2000,height:1200,close(){closed=true;}};},
    OffscreenCanvas:class {constructor(w,h){this.width=w;this.height=h;}getContext(){return {drawImage(){}};}async convertToBlob(){return new Blob(['salary-only']);}},
    chrome:{windows:{get:async()=>({state:minimized?'minimized':'normal',focused:!minimized})},
      tabs:{query:async()=>[{id:12,url:page.url}],captureVisibleTab:async()=>{captured++;return 'data:image/png;base64,'+btoa('full-viewport');}},
      scripting:{executeScript:async()=>[{result:page}]}},readBossPage(){},page,tab:{id:12,windowId:1,url:page.url},job:{salary_raw:'\uE039K',url:'https://www.zhipin.com/job_detail/a.html'}});
  vm.runInContext(fs.readFileSync(path.join(extension,'reader.js'),'utf8'),context);
  await assert.rejects(vm.runInContext('captureSalary(tab,page,job)',context),/前台可见/);assert.equal(captured,0);
  minimized=false;const image=await vm.runInContext('captureSalary(tab,page,job)',context);
  assert.equal(image.data_url,'data:image/png;base64,'+btoa('salary-only'));assert.equal(closed,true);
  assert.equal(image.width,212);assert.equal(image.height,68);
});
