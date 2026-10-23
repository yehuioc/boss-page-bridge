// Boss adapter owned by the worker. The scheduling/cancellation pattern is
// adapted from xiaohongshu-skills/extension/{background,executor}.js.
const allowedBoss = raw => {try {const u = new URL(raw); return u.protocol === 'https:' && ['www.zhipin.com', 'zhipin.com'].includes(u.hostname);} catch (_) {return false;}};
function bossAccount(page) {
  return page.browser?.controls.find(c => c.kind === 'page_link' && c.href === 'https://www.zhipin.com/web/geek/recommend' && /nav-figure|user-nav/.test(c.context || ''))?.label || null;
}
function pageUsable(page) {
  if (page.blocker) return true;
  const path = new URL(page.navigation_url || page.url).pathname;
  if (path === '/web/geek/jobs') return !!page.jobs?.length || /暂无.*职位|没有找到.*职位|暂无相关|未找到.*职位|没有相关职位/.test(page.text);
  if (/^\/job_detail\//.test(path)) return /职位描述|职位已关闭|停止招聘|职位不存在/.test(page.text);
  return page.ready === 'complete' && !!page.text;
}
function pageContentChanged(page, previous) {
  if (!previous) return true;
  if (previous.viewport?.document_id && page.viewport?.document_id && previous.viewport.document_id !== page.viewport.document_id) return true;
  if (page.navigation_url !== previous.navigation_url && new URL(page.url).pathname === '/web/geek/jobs' && new URL(previous.url).pathname === '/web/geek/jobs') {
    return JSON.stringify(page.jobs) !== JSON.stringify(previous.jobs);
  }
  return page.text !== previous.text;
}
function bossNavigationReached(requested, current) {
  if (!allowedBoss(current)) return false;
  const wanted = new URL(requested), actual = new URL(current);
  // The bare home URL legitimately redirects to the account's city homepage.
  // Do not generalize this exception to job IDs, filters, or requested cities.
  const homeRedirect = wanted.pathname === '/' && /^\/(?:jiangmen\/|c\d+\/)?$/.test(actual.pathname);
  if (wanted.pathname !== actual.pathname && !homeRedirect) return false;
  return [...wanted.searchParams].every(([key,value])=>actual.searchParams.get(key)===value);
}
function createBossExecutor({getBinding, getJob, request, publish, pause, adoptChatTab = async () => {}}) {
  const history = () => {const b = getBinding(); if (!b) throw Error('接管已停止'); return b.history ||= [];};
  async function check(session) {
    const valid = () => {
      const b = getBinding(), job = getJob();
      if (!b || b.session !== session || job?.abort.signal.aborted) throw Error('接管已停止或标签页重新绑定');
      if (job && job.expires * 1000 <= Date.now()) throw Error('指令已过期，未继续执行');
      return b;
    };
    const b = valid(), tab = await chrome.tabs.get(b.tab_id); valid();
    if (!allowedBoss(tab.url) || tab.discarded || tab.frozen) {
      const reason = !allowedBoss(tab.url) ? '绑定页已离开 Boss' : '绑定页被冻结或释放';
      pause(reason + '，请核对页面后重新连接。状态：' + JSON.stringify({url: tab.url || null, pendingUrl: tab.pendingUrl || null, status: tab.status, frozen: !!tab.frozen, discarded: !!tab.discarded})); throw Error(reason);
    }
    return tab;
  }
  async function observe(tab) {
    await boundedRead(chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', files: ['browser-controls.js', 'read-page.js', 'extract-job.js', 'conversation.js']}));
    const results = await boundedRead(chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED',
      func: () => {const page = readBossPage(),job=extractBossJob(page); return {...page, job,
        ...(chrome.runtime.getManifest().version.startsWith('0.7.') ? {interaction:readBossInteraction(job)} : {})};}}));
    if (!results[0]?.result) throw Error('Boss 没有返回页面结果');
    return results[0].result;
  }
  function identity(page) {
    const b = getBinding(), account = bossAccount(page);
    if (!account || !b || b.account !== account) {
      pause('登录账号改变或无法核对，请在网页检查后重新连接');
      throw Error('登录账号改变或无法核对');
    }
  }
  async function delay(ms, session) {
    const signal = getJob()?.abort.signal;
    await new Promise((resolve, reject) => {
      const cancelled = () => {clearTimeout(timer); reject(Error('操作已停止'));};
      const timer = setTimeout(() => {signal?.removeEventListener('abort', cancelled); resolve();}, ms);
      if (signal?.aborted) cancelled(); else signal?.addEventListener('abort', cancelled, {once: true});
    });
    await check(session);
  }
  async function read(session, changedFrom = null) {
    let tab = await check(session), page = await observe(tab);
    if (changedFrom || !pageUsable(page) || !bossAccount(page)) {
      const deadline = Date.now() + 7000;
      let previous = '', stable = 0;
      while (Date.now() < deadline) {
        await check(session);
        if (page.blocker) break;
        stable = page.text === previous ? stable + 1 : 0;
        if (pageContentChanged(page, changedFrom) && stable >= 1 && page.ready === 'complete' && pageUsable(page) && bossAccount(page)) break;
        previous = page.text;
        await delay(250, session);
        page = await observe(await check(session));
      }
    }
    await check(session);
    if (!page.blocker && (!pageUsable(page) || page.ready !== 'complete')) throw Error('页面尚未加载出职位或明确空结果，本次未认定操作成功');
    if (!page.blocker && changedFrom && page.navigation_url !== changedFrom.navigation_url && !pageContentChanged(page, changedFrom)) throw Error('搜索地址已改变，但新结果尚未替换旧列表；未接入旧结果，可重新读取');
    if (!page.blocker && pageUsable(page)) identity(page);
    let salaryImage = null;
    if (page.job?.salary_status === 'needs_visual_review') {
      try {salaryImage = await boundedRead(captureSalary(await check(session), page, page.job));}
      catch (error) {page.job.warnings.push('薪资截图：' + error.message);}
    }
    await check(session);
    const snapshot = {...page, salary_image: salaryImage};
    await request('/snapshot', {...snapshot, binding_session: session,
      ...(getJob()?.remote && /^0\.[67]\./.test(chrome.runtime.getManifest().version) ? {command_id:getJob().id} : {})});
    await check(session);
    publish(snapshot);
    if (page.blocker) {
      pause(page.blocker === 'verification_required' ? 'Boss 显示验证或访问限制，请在网页处理后重新连接' : 'Boss 要求重新登录，请处理后重新连接');
      throw Error('Boss 要求登录或验证，接管已暂停');
    }
    if (!pageUsable(page)) throw Error('页面尚未加载出职位或明确空结果，本次未认定操作成功');
    return snapshot;
  }
  async function execute(command, previous) {
    const session = command.session, tab = await check(session);
    if (command.action !== 'read') identity(await observe(tab));
    await check(session);
    const navigate = async (raw, push = true) => {
      const safe = bossBrowseUrl(raw);
      if (!safe) throw Error('只允许打开 Boss 浏览页面');
      if (push && bossBrowseUrl(tab.url)) history().push(bossBrowseUrl(tab.url));
      await check(session);
      await chrome.tabs.update(tab.id, {url: safe});
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const current = await check(session);
        if (current.status === 'complete' && bossNavigationReached(safe,current.url)) return;
        await delay(200, session);
      }
      throw Error('页面未在时限内加载，未重发导航');
    };
    if (['open_job', 'navigate'].includes(command.action)) {
      if (command.action === 'open_job' && !/^https:\/\/www\.zhipin\.com\/job_detail\/[^/]+\.html$/.test(command.args.url)) throw Error('职位链接无效');
      await navigate(command.args.url);
    } else if (command.action === 'back') {
      if (!history().length) throw Error('本次连接尚无可返回的浏览页面');
      const target=history().at(-1);
      await navigate(target, false);
      history().pop();
    } else if (command.action === 'reload') {
      await chrome.tabs.reload(tab.id); await delay(300, session);
    } else if (['click', 'input', 'hover'].includes(command.action)) {
      const args = command.args;
      const results = await boundedRead(chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED',
        func: (key, ref, action, value) => performBossControl(key, ref, action, value), args: [args.key, args.ref, command.action, args.value || null]}));
      await check(session);
      if (results[0]?.result?.error) throw Error(results[0].result.error);
      if (results[0]?.result?.result?.navigate_to) await navigate(results[0].result.result.navigate_to);
    } else if (command.action === 'scroll') {
      if (!Number.isFinite(command.args.y) || Math.abs(command.args.y) > 2000) throw Error('滚动范围无效');
      const scroll = await boundedRead(chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED',
        func: (target,y) => performBossScroll(target,y), args: [command.args.target || 'page',command.args.y]}));
      if(scroll[0]?.result?.error) throw Error(scroll[0].result.error);
      await delay(650, session);
    } else if (command.action==='inquiry_check') {
      const response=await boundedRead(chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:args=>checkBossInquiryDraft(args),args:[command.args]}));
      if(response[0]?.result?.error)throw Error(response[0].result.error);
    } else if (['inquiry_contact','inquiry_continue','inquiry_send'].includes(command.action)) {
      if(!getJob()?.remote)throw Error('沟通只能来自已确认批次');
      await request('/inquiries/permit',{id:command.id,session});
      await check(session);
      if(command.action==='inquiry_send') {
        const filled=await boundedRead(chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:args=>prepareBossInquirySend(args),args:[command.args]}));
        if(filled[0]?.result?.error)throw Error(filled[0].result.error);
        const readyDeadline=Date.now()+2500;
        let ready=false;
        while(Date.now()<readyDeadline) {
          await delay(200,session);
          const observed=await observe(await check(session));identity(observed);
          const c=observed.interaction?.conversation;
          if(!c||!bossIdentityEqual(command.args.identity,c.identity))throw Error('发送前未点击：会话身份变化');
          if(c.send_available){ready=true;break;}
        }
        if(!ready)throw Error('发送前未点击：输入后发送按钮仍不可用');
        await check(session);
      }
      const response=await boundedRead(chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',
        func:(action,args)=>performBossInquiry(action,args),args:[command.action,command.args]}));
      if(response[0]?.result?.error)throw Error(response[0].result.error);
      const deadline=Date.now()+7000;
      while(Date.now()<deadline) {
        await delay(400,session);
        if(command.action!=='inquiry_send')await adoptChatTab(command.args.identity,observe);
        const page=await observe(await check(session));
        if(command.action==='inquiry_send' && page.interaction?.conversation?.messages.some(m=>m.direction==='me'&&m.text===command.args.text))break;
        if(command.action!=='inquiry_send' && (page.interaction?.conversation || page.interaction?.greeting_visible))break;
      }
    } else if (command.action === 'focus') {
      await chrome.tabs.update(tab.id, {active: true}); await chrome.windows.update(tab.windowId, {focused: true});
    } else if (command.action !== 'read') throw Error('未开放此浏览操作');
    const result = await read(session, ['click', 'hover', 'navigate', 'open_job', 'back', 'reload'].includes(command.action) ? previous : null);
    if (command.action === 'hover' && !result.browser?.controls.some(c => c.kind === 'filter_option')) throw Error('筛选选项未展开，本次未认定筛选成功；可能需要真实鼠标悬停');
    return result;
  }
  return {check, observe, read, execute, reset: () => {if (getBinding()) getBinding().history = [];}};
}
