// Browser interaction surface: search and browsing only. Runs in this extension's isolated world.
function bossBrowseUrl(raw) {
  const u = new URL(raw, location.href);
  if (u.origin !== 'https://www.zhipin.com' || u.username || u.password) return null;
  if (!(/^\/job_detail\/[^/]+\.html$/.test(u.pathname) || /^\/web\/geek\/(jobs|recommend|chat)$/.test(u.pathname) || /^\/(?:jiangmen\/|c\d+\/)?$/.test(u.pathname) || /^\/gongsi\/(?:job\/)?[^/]+\.html$/.test(u.pathname))) return null;
  const safe = new URL(u.origin + u.pathname);
  for (const key of ['query', 'city', 'experience', 'degree', 'salary', 'jobType', 'industry', 'scale', 'stage', 'position']) {
    if (u.searchParams.has(key)) safe.searchParams.set(key, u.searchParams.get(key));
  }
  return safe.href;
}
function bossControlKind(element) {
  const tag = element.tagName.toLowerCase();
  const label = (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
  if (element.getAttribute('ka') === 'switch_city_dialog_open') return {kind:'filter',label:'城市：' + label,href:null};
  if (tag === 'li' && element.closest?.('.city-select-dialog .city-list-hot') && /^[\u4e00-\u9fff]{2,8}$/.test(label)) return {kind:'filter_option',label,href:null};
  if (tag === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    const hint = (element.getAttribute('placeholder') || '') + ' ' + (element.getAttribute('aria-label') || '');
    if (['text', 'search'].includes(type) && /搜索|职位|公司/.test(hint) && !/联系人|聊天|消息|手机号|密码|验证码/.test(hint)) return {kind: 'search_input', label: hint.trim(), href: null};
    return null;
  }
  if (/^(立即沟通|继续沟通|发送|发简历|感兴趣|收藏|换电话|换微信|同意|拒绝|投递|上传|删除|保存)/.test(label)) return null;
  if (tag === 'a' && element.href) {
    const href = bossBrowseUrl(element.href);
    if (href && label && label.length <= 100) return {kind: /\/job_detail\//.test(href) ? 'job_link' : 'page_link', label, href};
  }
  if (label === '搜索') return {kind: 'search_button', label, href: null};
  if (/^(求职类型|薪资待遇|工作经验|学历要求|公司行业|公司规模|清空)(?:\(\d+\))?$/.test(label)) {
    const wrapper = element.closest?.('.condition-filter-select,.condition-industry-select');
    if (wrapper && wrapper !== element) return null;
    return {kind: 'filter', label, href: null};
  }
  if (/^(不限|全部|经验不限|学历不限|应届生|在校生|1年以内|1-3年|3-5年|5-10年|10年以上|高中|中专\/中技|大专|本科|硕士|博士|全职|兼职|实习|3K以下|3-5K|5-10K|10-20K|20-50K|50K以上)$/.test(label) &&
      element.closest?.('[role="listbox"],[role="menu"],[class*="dropdown"],[class*="filter-options"]')) return {kind: 'filter_option', label, href: null};
  return null;
}
function observeBossControls() {
  const records = [];
  const descriptors = [];
  const seen = new Set();
  for (const element of document.querySelectorAll('input,button,a,[role="button"],[role="option"],li,span,[class*="filter"],[class*="select"],[ka="switch_city_dialog_open"]')) {
    const data = bossControlKind(element);
    if (!data || element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || style.visibility === 'hidden' || style.display === 'none') continue;
    const signature = data.kind + ':' + data.label + ':' + data.href;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const ref = 'c' + records.length;
    const ancestors = [];
    for (let p = element; p && ancestors.length < 4; p = p.parentElement) ancestors.push(p.tagName.toLowerCase() + '.' + (p.getAttribute('class') || ''));
    let context = ancestors.join(' > ');
    if (data.kind === 'filter' && /^工作经验/.test(data.label)) {
      const choices = [...(element.querySelectorAll?.('li[ka^="sel-job-rec-exp-"]') || [])].slice(0, 10).map(option => ({
        label: (option.textContent || '').trim().slice(0, 20), value: option.getAttribute('ka')?.match(/^sel-job-rec-exp-(\d+)$/)?.[1]
      })).filter(choice => choice.label && choice.value);
      if (choices.length) context = 'experience_options=' + JSON.stringify(choices) + ' | ' + context;
    }
    else if (data.kind === 'filter') {
      const choices = [...(element.querySelectorAll?.('li[ka]') || [])].slice(0, 12).map(option => ({
        label: (option.textContent || '').trim().slice(0, 20), ka: option.getAttribute('ka')
      }));
      if (choices.length) context = JSON.stringify(choices);
    }
    records.push({element, ...data}); descriptors.push({ref, ...data, value: data.kind === 'search_input' ? element.value.slice(0, 100) : null, context: context.slice(0, 400)});
    if (records.length >= 80) break;
  }
  const old = globalThis.__bossControlState;
  const unchanged = old && old.url === location.href && old.records.length === records.length && records.every((r, i) => {
    const previous = old.records[i];
    return previous.element === r.element && previous.kind === r.kind && previous.label === r.label && previous.href === r.href;
  });
  const key = unchanged ? old.key : crypto.randomUUID();
  // Keep a few observed generations. An unrelated job-card rerender must not
  // invalidate the same, still-connected search input. Actions below continue
  // checking the exact target element, its purpose, URL, age and occlusion.
  const history = globalThis.__bossControlHistory ||= new Map();
  if (old) history.set(old.key, old);
  for (const [savedKey, state] of history) if (Date.now() - state.observed > 120000) history.delete(savedKey);
  while (history.size > 8) history.delete(history.keys().next().value);
  globalThis.__bossControlState = {key, url: location.href, records, observed: Date.now()};
  return {key, controls: descriptors, ...(/^0\.[67]\./.test(globalThis.chrome?.runtime?.getManifest?.().version || '') ? {filters:readBossFilters()} : {})};
}
function readBossFilters() {
  const catalog = [];
  const keys = {jobType:'求职类型',salary:'薪资待遇',exp:'工作经验',degree:'学历要求'};
  for (const [code, label] of Object.entries(keys)) {
    const options = [];
    for (const el of document.querySelectorAll(`li[ka^="sel-job-rec-${code}-"]`)) {
      const value = el.getAttribute('ka')?.match(new RegExp(`^sel-job-rec-${code}-(\\d+)$`))?.[1];
      const text = (el.textContent || '').trim();
      if (value && text && text.length <= 30 && options.length < 15) options.push({label:text,value,selected:!!el.classList?.contains('active')});
    }
    if (options.length) catalog.push({key:code === 'exp' ? 'experience' : code,label,options});
  }
  return catalog;
}
function scrollBossRegion(target, y) {
  if (!['page','list','detail'].includes(target) || !Number.isFinite(y) || Math.abs(y)>2000) throw Error('滚动范围无效');
  if (target === 'page') {window.scrollBy({top:y,behavior:'instant'}); return;}
  const anchor = target === 'list' ? [...document.querySelectorAll('a[href]')].find(a => /\/job_detail\/[^/]+\.html(?:\?|$)/.test(a.href) && a.innerText?.trim() && a.innerText.trim() !== '查看更多信息') :
    [...document.querySelectorAll('h2,h3,h4')].find(e => e.innerText?.trim() === '职位描述');
  if (!anchor) throw Error('未找到对应滚动区域');
  for (let p=anchor.parentElement;p && p !== document.body;p=p.parentElement) {
    if (p.scrollHeight > p.clientHeight+5 && /auto|scroll/.test(getComputedStyle(p).overflowY)) {p.scrollBy({top:y,behavior:'instant'}); return;}
  }
  window.scrollBy({top:y,behavior:'instant'});
}
function performBossScroll(target,y) {try {scrollBossRegion(target,y);return {ok:true};} catch(error) {return {error:error.message};}}
function actOnBossControl(key, ref, action, value) {
  const latest = globalThis.__bossControlState;
  const state = latest?.key === key ? latest : globalThis.__bossControlHistory?.get(key);
  if (!state || state.key !== key || state.url !== location.href || Date.now() - state.observed > 120000 || !/^c\d+$/.test(ref)) throw Error('页面引用已失效，请重新读取');
  const record = state.records[Number(ref.slice(1))];
  if (!record || !record.element.isConnected) throw Error('控件已消失，请重新读取');
  const current = bossControlKind(record.element);
  if (!current || current.kind !== record.kind || current.label !== record.label || current.href !== record.href) throw Error('控件用途已变化，未执行操作');
  const element = record.element, r = element.getBoundingClientRect();
  if (element.disabled || element.getAttribute('aria-disabled') === 'true' || !r.width || !r.height) throw Error('控件不可用');
  const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
  const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight || r.bottom <= 0 || r.top >= innerHeight) throw Error('控件不在屏幕内');
  const top = document.elementFromPoint(x, y);
  if (!top || (top !== element && !element.contains(top))) throw Error('控件被其他界面遮挡，未执行操作');
  if (action === 'input') {
    if (record.kind !== 'search_input' || typeof value !== 'string' || !value.trim() || value.length > 100) throw Error('只允许填写搜索词');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', {bubbles: true}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
    if (element.value !== value) throw Error('搜索框没有保留输入');
    return {filled: true};
  }
  if (action === 'hover') {
    if (record.kind !== 'filter') throw Error('仅允许展开已识别的筛选控件');
    let node = element.querySelector?.('.current-select') || element;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      node.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: x, clientY: y}));
      node.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false, clientX: x, clientY: y}));
    }
    return {hovered: record.label};
  }
  if (action !== 'click' || record.kind === 'search_input') throw Error('未开放此控件动作');
  if (record.href) return {navigate_to: record.href};
  // Only exact search/filter labels above can reach this click.
  (record.kind === 'filter' ? element.querySelector?.('.current-select') || element : element).click();
  return {clicked: record.label};
}
// Expected stale/covered-reference failures are data at the injection boundary,
// so Chrome does not record a routine refused action as an uncaught page error.
function performBossControl(key, ref, action, value) {
  try {
    const result = actOnBossControl(key, ref, action, value);
    if (action === 'click' && result.clicked && /^(求职类型|薪资待遇|工作经验|学历要求|公司行业|公司规模)/.test(result.clicked)) {
      const record = globalThis.__bossControlState?.records.find(r => r.kind === 'filter' && r.label === result.clicked);
      const menu = record?.element.querySelector?.('.filter-select-dropdown');
      if (menu && (!menu.getBoundingClientRect().height || getComputedStyle(menu).display === 'none' || getComputedStyle(menu).visibility === 'hidden')) {
        throw Error('筛选菜单未展开，未认定操作成功；可使用已观察到的普通筛选网址，或手动悬停后选择可见选项');
      }
    }
    return {result};
  }
  catch (error) {return {error: error.message};}
}
