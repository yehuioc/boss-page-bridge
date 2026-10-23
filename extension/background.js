importScripts('browser-controls.js', 'read-page.js', 'extract-job.js', 'conversation.js', 'reader.js', 'executor.js');
// Worker ownership, independent heartbeats, session persistence and no replay:
// adapted from the verified xiaohongshu-skills background runner.
const BASE = 'http://127.0.0.1:8926', ALARM = 'boss-runner-wakeup';
const panels = new Set();
let token = '', binding = null, active = null, snapshot = null, connected = false;
let message = '请先连接本机，再连接当前 Boss 页。', timer, ticking = false, initialized, lastTick = 0, writes = Promise.resolve(), generation = 0;
let searchState = null, workflowActive = false, searchChecked = 0, searchView = 'state';
let assistantState = null, assistantTimer;
const chatTabs = new Map();
const version = () => chrome.runtime.getManifest().version;
const wireBinding = () => binding ? {tab_id: binding.tab_id, session: binding.session, url: binding.url} : null;
const executor = createBossExecutor({getBinding: () => binding, getJob: () => active, request,
  publish: page => {snapshot = page; chrome.storage.session.set({bossSnapshot: page}); broadcast();}, pause, adoptChatTab});
function state() {return {version: version(), paired: !!token, binding: binding ? {tab_id: binding.tab_id, session: binding.session, url: binding.url} : null, busy: !!active, connected, message, snapshot, search:searchState, workflow_active:workflowActive, assistant:assistantState};}
async function adoptChatTab(expected, observe) {
  const job=active,b=binding;
  if(!job?.remote||!b||!['inquiry_contact','inquiry_continue'].includes(job.action))return;
  const candidates=[];
  for(const [id,record] of chatTabs) {
    if(record.command!==job.id||record.opener!==b.tab_id)continue;
    const tab=await chrome.tabs.get(id).catch(()=>null);
    if(tab?.status==='complete'&&tab.url?.startsWith('https://www.zhipin.com/web/geek/chat'))candidates.push(tab);
  }
  if(candidates.length>1)throw Error('本次操作出现多个消息标签页，未猜测接管目标');
  if(!candidates.length)return;
  const tab=candidates[0],page=await observe(tab);
  if(!page.interaction?.conversation?.identity_complete||!bossIdentityEqual(expected,page.interaction.conversation.identity)||bossAccount(page)!==b.account)throw Error('新消息标签页身份不符，未接管');
  if(binding!==b||active!==job||job.abort.signal.aborted)throw Error('接管已停止');
  const old={...b};b.tab_id=tab.id;b.url=tab.url;b.auto_discardable=tab.autoDiscardable;
  await chrome.tabs.update(tab.id,{autoDiscardable:false});await restoreTab(old);await persist();
  chatTabs.delete(tab.id);
}
async function refreshAssistant() {
  clearTimeout(assistantTimer);
  if(!token||!panels.size)return;
  try {assistantState=await request('/assistant/state',{}); if(searchState?.run)searchState=await request('/search/'+searchView,{});broadcast();}
  catch(error){message='助手状态读取失败：'+error.message;broadcast();}
  finally {if(panels.size&&token)assistantTimer=setTimeout(refreshAssistant,2500);}
}
function broadcast() {for (const port of panels) {try {port.postMessage(state());} catch (_) {panels.delete(port);}}}
function persist() {
  const value = {binding: binding ? {...binding} : null, flight: active ? {id: active.id, session: active.session, remote: active.remote} : null, message, lastTick};
  writes = writes.catch(() => {}).then(() => chrome.storage.session.set({bossRunner: value})); return writes;
}
async function request(path, body) {
  const response = await fetch(BASE + path, {method: 'POST', credentials: 'omit', redirect: 'error',
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
  const result = await response.json(); if (!response.ok) throw Error(result.error || '本机服务拒绝请求'); return result;
}
async function restoreTab(old) {
  if (!old || typeof old.auto_discardable !== 'boolean') return;
  await chrome.tabs.update(old.tab_id, {autoDiscardable: old.auto_discardable}).catch(() => {});
  if (binding?.tab_id === old.tab_id) await chrome.tabs.update(old.tab_id, {autoDiscardable: false}).catch(() => {});
}
function pause(reason = '已停止接管；配对保留，继续时请重新连接当前页。') {
  const old = binding;
  generation++;
  binding = null; connected = false; workflowActive = false; message = reason; clearTimeout(timer);
  active?.abort.abort();
  persist(); chrome.alarms.clear(ALARM).catch(() => {}); broadcast();
  restoreTab(old);
  if (token && old) {
    request('/diagnostic', {error: ('[' + old.session + '] ' + reason).slice(0, 1000)}).catch(() => {});
    request('/revoke', {session: old.session, server_id: old.server_id}).then(async()=>{
      if(panels.size) {searchState=await request('/search/state',{});broadcast();}
    }).catch(() => {});
  }
}
async function init() {
  if (initialized) return initialized;
  initialized = (async () => {
    token = (await chrome.storage.local.get('token')).token || '';
    const saved = await chrome.storage.session.get(['bossRunner', 'bossSnapshot']);
    binding = saved.bossRunner?.binding || null; snapshot = saved.bossSnapshot || null;
    message = saved.bossRunner?.message || message; lastTick = saved.bossRunner?.lastTick || Date.now();
    if (binding) {
      try {
        if (saved.bossRunner.flight) throw Error('后台执行器曾中断，未重放未完成操作，请核对页面后重新连接');
        if (Date.now() - lastTick > 20000) throw Error('浏览器曾长时间暂停或休眠，请核对页面后重新连接');
        const server = await request('/ping', {});
        if (server.server_id !== binding.server_id) throw Error('本机服务已重启，旧接管未恢复，请重新连接');
        const page = await executor.observe(await executor.check(binding.session));
        if (page.blocker || bossAccount(page) !== binding.account) throw Error('登录状态改变或账号无法核对，请重新连接');
        connected = true; lastTick = Date.now(); await persist();
        await chrome.alarms.create(ALARM, {periodInMinutes: 1}); schedule(0);
      } catch (error) {pause(error.message);}
    }
    return state();
  })(); return initialized;
}
function schedule(ms = 1500) {clearTimeout(timer); if (binding && token) timer = setTimeout(tick, ms);}
async function tick() {
  if (ticking) return; ticking = true;
  try {
    if (!binding || !token) return;
    if (lastTick && Date.now() - lastTick > 20000) {pause('浏览器运行曾暂停或电脑休眠，请核对页面后重新连接'); return;}
    lastTick = Date.now();
    const tab = await executor.check(binding.session); // A real Chrome API observation also resets worker idle time.
    const window = await chrome.windows.get(tab.windowId);
    const sent = wireBinding(), serverId = binding.server_id;
    const result = await request('/poll', {binding: sent, busy: !!active, version: version(), server_id: serverId,
      runtime: {runner: 'background', panels: panels.size, tab_active: !!tab.active, window_state: window.state || 'normal'},
      executing: active?.remote ? {id: active.id, session: active.session} : null});
    if (!binding || binding.session !== sent.session) return;
    if (result.server_id !== serverId) {pause('本机服务已重启，请重新连接'); return;}
    connected = true;
    workflowActive = !!result.workflow_active;
    if (panels.size && Date.now()-searchChecked>5000) {
      searchChecked = Date.now();
      searchState = await request('/search/' + searchView, {});
    }
    if (result.cancel) {pause('本次操作已取消或过期，未继续执行'); return;}
    if (result.command && !active) runJob(result.command, true).catch(() => {});
    await persist();
  } catch (error) {pause('连接已暂停：' + error.message);}
  finally {ticking = false; broadcast(); schedule();}
}
async function runJob(command, remote) {
  if (active) throw Error('当前页正在操作，请等待完成或立即停止');
  if (!binding || command.session !== binding.session || command.expires * 1000 <= Date.now()) throw Error('指令已失效');
  const job = {...command, remote, abort: new AbortController()};
  active = job; const previous = snapshot; snapshot = null;
  chrome.storage.session.set({bossSnapshot: null});
  message = '正在操作绑定的 Boss 页；可以关闭侧栏或切换标签页。'; broadcast();
  let error = null, timeout, cancelled;
  try {
    await persist();
    const interrupted = new Promise((_, reject) => {
      cancelled = () => reject(Error('操作已停止，迟到结果不会接入'));
      if (job.abort.signal.aborted) cancelled(); else job.abort.signal.addEventListener('abort', cancelled, {once: true});
      timeout = setTimeout(() => {job.abort.abort();}, Math.max(1, command.expires * 1000 - Date.now()));
    });
    await Promise.race([executor.execute(command, previous), interrupted]);
    if (!binding || binding.session !== command.session || job.abort.signal.aborted) throw Error('操作已停止，结果未接入');
    message = '已自动回传；后台浏览已开启，明确停止才结束接管。';
  } catch (failure) {
    error = failure.message;
    if (binding?.session === command.session) message = '本次操作未完成：' + error;
  } finally {
    clearTimeout(timeout); if (cancelled) job.abort.signal.removeEventListener('abort', cancelled);
    if (remote) await request('/result', {id: command.id, session: command.session, error}).catch(failure => {
      if (binding?.session === command.session) pause('执行结果未接入：' + failure.message);
    });
    active = null; await persist(); broadcast(); schedule(0);
  }
  if (error) throw Error(error); return state();
}
async function selectBossTab() {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!allowedBoss(tab?.url)) throw Error('请先选中需要连接的 Boss 标签页，再点连接当前页'); return tab;
}
async function handle(action, args = {}) {
  await init();
  if (action === 'state') return state();
  if (['assistant_state','assistant_analyze','assistant_auth','inquiry_prepare','inquiry_template','inquiry_approve','inquiry_replies','inquiry_analyze_replies'].includes(action)) {
    const paths={assistant_state:'/assistant/state',assistant_analyze:'/assistant/analyze',assistant_auth:'/assistant/auth',
      inquiry_prepare:'/inquiries/prepare',inquiry_template:'/inquiries/template',inquiry_approve:'/inquiries/approve',inquiry_replies:'/inquiries/replies',inquiry_analyze_replies:'/inquiries/analyze-replies'};
    const result=await request(paths[action],args);
    if(action==='assistant_auth')return result;
    assistantState=await request('/assistant/state',{});
    if(action.startsWith('inquiry_')&&action!=='inquiry_analyze_replies')workflowActive=['preparing','sending'].includes(assistantState.inquiries?.status);
    broadcast();return state();
  }
  if (['search_state','search_start','search_stop','search_library'].includes(action)) {
    const path = {'search_state':'state','search_start':'start','search_stop':'stop','search_library':'library'}[action];
    searchState = await request('/search/' + path, action === 'search_start' ? args : {});
    searchView = path === 'library' ? 'library' : 'state';
    if(path !== 'library') workflowActive = ['running','stopping'].includes(searchState.run?.status);
    broadcast(); return state();
  }
  if (action === 'search_export') return request('/search/export', args);
  if (action === 'open_candidate') {
    if (workflowActive || active) throw Error('请先停止找岗任务再打开候选');
    if (!binding || !searchState?.run?.candidates?.[args.url]) throw Error('请先连接 Boss，并选择已保存的候选');
    return runJob({id:crypto.randomUUID(),session:binding.session,action:'open_job',args:{url:args.url},expires:Date.now()/1000+25},false);
  }
  if (action === 'stop') {pause(); await request('/assistant/stop',{}).catch(()=>{});await persist();return state();}
  if (action === 'ping') {const result = await request('/ping', {}); message = result.message; broadcast(); return state();}
  if (action === 'pair') {
    if (active) throw Error('请先停止当前操作');
    pause(); const result = await request('/pair', {code: String(args.code || '').trim()});
    token = result.token; await chrome.storage.local.set({token}); message = result.message; broadcast(); return state();
  }
  if (action === 'bind') {
    if (active) throw Error('请先停止当前操作并等待结束，再连接其他页面');
    pause(); const selectedGeneration = generation; executor.reset(); snapshot = null;
    const tab = await selectBossTab(), server = await request('/ping', {});
    const page = await executor.observe(tab), account = bossAccount(page);
    if (selectedGeneration !== generation) throw Error('连接过程已被停止，未开启接管');
    if (page.blocker || !account) throw Error('未能确认当前 Boss 登录账号；请在网页正常登录后再连接');
    const session = crypto.randomUUID();
    binding = {tab_id: tab.id, session, url: tab.url, account, server_id: server.server_id, auto_discardable: tab.autoDiscardable, history: []}; lastTick = Date.now();
    try {
      await chrome.tabs.update(tab.id, {autoDiscardable: false}); await executor.check(session);
      await request('/poll', {binding: wireBinding(), busy: true, version: version(), server_id: binding.server_id});
      connected = true; await persist(); await chrome.alarms.create(ALARM, {periodInMinutes: 1}); schedule(0);
      return await runJob({id: crypto.randomUUID(), session, action: 'read', args: {}, expires: Date.now() / 1000 + 25}, false);
    } catch (error) {if (binding?.session === session) pause(error.message); throw error;}
  }
  if (action === 'read' || action === 'focus') {
    if (workflowActive) throw Error('找岗任务正在浏览；请先停止任务再手动操作');
    if (!binding) throw Error('请先连接当前 Boss 页');
    return runJob({id: crypto.randomUUID(), session: binding.session, action, args: {}, expires: Date.now() / 1000 + 25}, false);
  }
  throw Error('未开放此动作');
}
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(() => {});
chrome.action.onClicked.addListener(tab => {chrome.sidePanel.open({windowId: tab.windowId}).catch(() => {});});
const trustedPanel = sender => sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
chrome.runtime.onMessage.addListener((value, sender, reply) => {
  if (!trustedPanel(sender)) return false;
  handle(value.action, value.args).then(result => reply({result}), error => reply({error: error.message})); return true;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'boss-panel' || !trustedPanel(port.sender)) return port.disconnect();
  panels.add(port); port.onDisconnect.addListener(() => {panels.delete(port);if(!panels.size)clearTimeout(assistantTimer);});
  init().then(()=>{broadcast();refreshAssistant();});
});
chrome.tabs.onCreated?.addListener(tab=>{
  if(active?.remote&&binding&&tab.openerTabId===binding.tab_id&&['inquiry_contact','inquiry_continue'].includes(active.action))
    chatTabs.set(tab.id,{command:active.id,opener:tab.openerTabId});
});
chrome.alarms.onAlarm.addListener(event => {if (event.name === ALARM) init().then(() => {if (binding) schedule(0); else chrome.alarms.clear(ALARM);});});
chrome.runtime.onStartup.addListener(() => init()); chrome.runtime.onInstalled.addListener(() => init());
chrome.tabs.onRemoved.addListener(id => {init().then(() => {if (binding?.tab_id === id) pause('绑定 Boss 页已关闭，接管已停止');});});
chrome.tabs.onUpdated.addListener((id, change) => {init().then(async () => {
  if (binding?.tab_id !== id || !((change.url && !allowedBoss(change.url)) || change.discarded || change.frozen)) return;
  const session = binding.session;
  try {
    // Event callbacks can be overtaken by navigation or a newer binding. Check
    // the current tab rather than revoking a grant from an obsolete event.
    const tab = await chrome.tabs.get(id);
    if (binding?.session !== session) return;
    if (!allowedBoss(tab.url) || tab.discarded || tab.frozen) {
      const detail = {event: change, current: {url: tab.url || null, pendingUrl: tab.pendingUrl || null, status: tab.status, frozen: !!tab.frozen, discarded: !!tab.discarded}};
      pause('标签页状态要求暂停：' + JSON.stringify(detail));
    }
  } catch (error) {if (binding?.session === session) pause('无法核对绑定标签页：' + error.message);}
});});
