const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/browser-controls.js'), 'utf8');

function setup() {
  class Input {get value() {return this._value || '';} set value(value) {this._value = value;}}
  const events = [];
  const rect = {left: 20, top: 20, right: 200, bottom: 50, width: 180, height: 30};
  function element(tag, text, attributes = {}) {
    const el = tag === 'INPUT' ? new Input() : {};
    return Object.assign(el, {tagName: tag, innerText: text, isConnected: true, disabled: false,
      getAttribute: name => attributes[name] || null, getBoundingClientRect: () => rect,
      dispatchEvent: event => events.push(event.type), click: () => events.push('click:' + el.innerText), contains: item => item === el});
  }
  const input = element('INPUT', '', {placeholder: '搜索职位、公司'}), search = element('BUTTON', '搜索');
  let elements = [input, search, element('BUTTON', '立即沟通'), element('INPUT', '', {placeholder: '输入消息'})];
  let hit = null;
  const context = vm.createContext({URL, Date, crypto: require('node:crypto').webcrypto,
    location: {href: 'https://www.zhipin.com/web/geek/jobs'}, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({visibility: 'visible', display: 'block'}),
    document: {querySelectorAll: () => elements, elementFromPoint: () => hit || input},
    HTMLInputElement: Input, Event: class {constructor(type) {this.type = type;}}});
  vm.runInContext(source, context);
  return {context, input, search, events, setElements: items => {elements = items;}, setHit: item => {hit = item;}};
}

test('exposes search controls but never message fields or communication buttons', () => {
  const {context} = setup();
  const observed = vm.runInContext('observeBossControls()', context);
  assert.deepEqual(Array.from(observed.controls, c => c.kind), ['search_input', 'search_button']);
});

test('fills search through browser events and reads the retained value', () => {
  const {context, input, events} = setup();
  context.key = vm.runInContext('observeBossControls().key', context);
  vm.runInContext("actOnBossControl(key, 'c0', 'input', '项目管理')", context);
  assert.equal(input.value, '项目管理');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(vm.runInContext('observeBossControls().controls[0].value', context), '项目管理');
});

test('stable reads preserve references; changed DOM or changed use rejects old references', () => {
  const {context, input, search, setElements, setHit} = setup();
  context.key = vm.runInContext('observeBossControls().key', context);
  assert.equal(vm.runInContext('observeBossControls().key', context), context.key);
  search.innerText = '发送'; setHit(search);
  assert.throws(() => vm.runInContext("actOnBossControl(key, 'c1', 'click', null)", context), /用途已变化/);
  setElements([input]);
  vm.runInContext('observeBossControls()', context);
  setHit(input);
  vm.runInContext("actOnBossControl(key, 'c0', 'input', '项目管理')", context);
  assert.equal(input.value, '项目管理', 'an unrelated removed control must not invalidate the exact unchanged input');
  input.isConnected = false;
  assert.throws(() => vm.runInContext("actOnBossControl(key, 'c0', 'input', '其他词')", context), /控件已消失/);
});

test('covered controls and navigation invalidate actions without clicking', () => {
  const {context, setHit, events} = setup();
  context.key = vm.runInContext('observeBossControls().key', context);
  setHit({});
  assert.throws(() => vm.runInContext("actOnBossControl(key, 'c1', 'click', null)", context), /遮挡/);
  vm.runInContext("location.href = 'https://www.zhipin.com/web/geek/chat'", context);
  assert.throws(() => vm.runInContext("actOnBossControl(key, 'c1', 'click', null)", context), /引用已失效/);
  assert.equal(events.length, 0);
});

test('expected stale reference errors cross the injection boundary as data without clicking', () => {
  const {context, events} = setup();
  context.key = vm.runInContext('observeBossControls().key', context);
  vm.runInContext("location.href = 'https://www.zhipin.com/web/geek/chat'", context);
  const result = vm.runInContext("performBossControl(key, 'c1', 'click', null)", context);
  assert.match(result.error, /引用已失效/);
  assert.equal(events.length, 0);
});

test('experience choices come from observed DOM identifiers and nested filter labels are not duplicated', () => {
  const {context, search, setElements} = setup();
  const root = {...search, tagName:'DIV', innerText:'工作经验(1)',querySelectorAll:()=>[
    {textContent:' 在校生 ',getAttribute:()=> 'sel-job-rec-exp-108'},
    {textContent:' 1-3年 ',getAttribute:()=> 'sel-job-rec-exp-104'}]};
  root.closest=()=>root;
  const child={...search,tagName:'SPAN',innerText:'工作经验',closest:()=>root};
  setElements([root,child]);
  const controls=vm.runInContext('observeBossControls().controls',context);
  assert.equal(controls.length,1);assert.match(controls[0].context,/在校生.*108.*1-3年.*104/);
});

test('navigation retains search query but refuses APIs, logout, uploads and external links', () => {
  const {context} = setup();
  assert.equal(vm.runInContext("bossBrowseUrl('https://www.zhipin.com/web/geek/jobs?query=AI&ka=tracking')", context), 'https://www.zhipin.com/web/geek/jobs?query=AI');
  for (const url of ['https://evil.example/', 'https://www.zhipin.com/logout/', 'https://www.zhipin.com/wapi/send', 'https://www.zhipin.com/web/geek/resume']) {
    context.url = url;
    assert.equal(vm.runInContext('bossBrowseUrl(url)', context), null);
  }
});

test('job qualification text is not exposed as a filter option outside a dropdown', () => {
  const {context, input, search, setElements} = setup();
  const qualification = {...search, tagName: 'SPAN', innerText: '本科'};
  const option = {...qualification, closest: () => ({})};
  setElements([input, search, qualification]);
  assert.equal(vm.runInContext('observeBossControls().controls.some(c => c.kind === "filter_option")', context), false);
  setElements([input, search, option]);
  assert.equal(vm.runInContext('observeBossControls().controls.some(c => c.kind === "filter_option")', context), true);
});

test('contacts search is not a vacancy search; city option requires the exact city dialog',()=>{
  const {context,input,search,setElements}=setup();
  input.getAttribute=name=>name==='placeholder'?'搜索30天内的联系人':null;
  setElements([input]);assert.equal(vm.runInContext('observeBossControls().controls.length',context),0);
  const city={...search,tagName:'LI',innerText:'全国',closest:selector=>selector==='.city-select-dialog .city-list-hot'?{}:null};
  setElements([city]);assert.equal(vm.runInContext('observeBossControls().controls[0].kind',context),'filter_option');
  city.closest=()=>null;assert.equal(vm.runInContext('observeBossControls().controls.length',context),0);
});

test('filter catalog records only page-provided identifiers; list scrolling targets an overflow container',()=>{
  const {context}=setup();let scroll;
  const container={scrollHeight:2000,clientHeight:400,scrollBy:v=>scroll=v,parentElement:{}};
  const anchor={href:'https://www.zhipin.com/job_detail/a.html',innerText:'职位',parentElement:container};
  const option={textContent:'本科',getAttribute:()=> 'sel-job-rec-degree-203',classList:{contains:()=>true}};
  context.document.querySelectorAll=selector=>selector.includes('sel-job-rec-degree')?[option]:selector==='a[href]'?[anchor]:[];
  context.getComputedStyle=()=>({overflowY:'auto'});
  const catalog=vm.runInContext('readBossFilters()',context);
  assert.equal(catalog[0].key,'degree');assert.equal(catalog[0].options[0].value,'203');
  vm.runInContext("scrollBossRegion('list',800)",context);assert.equal(scroll.top,800);
  assert.throws(()=>vm.runInContext("scrollBossRegion('arbitrary',800)",context),/滚动范围无效/);
});

test('list readiness requires jobs or an explicit empty-result message', () => {
  const context = vm.createContext({URL, setInterval: () => {}, document: {getElementById: () => ({})},
    chrome: {storage: {local: {get: async () => ({})}}}});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../extension/executor.js'), 'utf8'), context);
  context.page = {url: 'https://www.zhipin.com/web/geek/jobs', text: '首页 搜索', ready: 'complete', jobs: []};
  assert.equal(vm.runInContext('pageUsable(page)', context), false);
  context.page.text = '暂无相关职位';
  assert.equal(vm.runInContext('pageUsable(page)', context), true);
  context.page.text = '首页 搜索'; context.page.jobs = [{text: '工程师'}];
  assert.equal(vm.runInContext('pageUsable(page)', context), true);
});

test('a changed search URL does not prove the old cards were replaced; full reload uses document identity', () => {
  const context=vm.createContext({URL});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/executor.js'),'utf8'),context);
  context.previous={url:'https://www.zhipin.com/web/geek/jobs',text:'old cards',jobs:[{url:'a'}],navigation_url:'https://www.zhipin.com/web/geek/jobs?query=old',viewport:{document_id:'one'}};
  context.page={...context.previous,navigation_url:'https://www.zhipin.com/web/geek/jobs?query=new'};
  assert.equal(vm.runInContext('pageContentChanged(page,previous)',context),false);
  context.page={...context.page,text:'old cards with changed notification'};
  assert.equal(vm.runInContext('pageContentChanged(page,previous)',context),false);
  context.page={...context.page,text:'new cards',jobs:[{url:'b'}]};
  assert.equal(vm.runInContext('pageContentChanged(page,previous)',context),true);
  context.page={...context.previous,viewport:{document_id:'two'}};
  assert.equal(vm.runInContext('pageContentChanged(page,previous)',context),true);
});
test('bare homepage may redirect to its city; job identity and requested filters cannot silently change',()=>{
  const context=vm.createContext({URL});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/executor.js'),'utf8'),context);
  const matches=(a,b)=>{context.a=a;context.b=b;return vm.runInContext('bossNavigationReached(a,b)',context);};
  assert.equal(matches('https://www.zhipin.com/','https://www.zhipin.com/jiangmen/'),true);
  assert.equal(matches('https://www.zhipin.com/','https://www.zhipin.com/c100000000/'),true);
  assert.equal(matches('https://www.zhipin.com/','https://evil.example/jiangmen/'),false);
  assert.equal(matches('https://www.zhipin.com/','https://www.zhipin.com/web/geek/chat'),false);
  assert.equal(matches('https://www.zhipin.com/job_detail/a.html','https://www.zhipin.com/job_detail/b.html'),false);
  assert.equal(matches('https://www.zhipin.com/web/geek/jobs?query=运营&city=1','https://www.zhipin.com/web/geek/jobs?city=1&query=运营'),true);
  assert.equal(matches('https://www.zhipin.com/web/geek/jobs?query=运营&city=1','https://www.zhipin.com/web/geek/jobs?city=2&query=运营'),false);
});
