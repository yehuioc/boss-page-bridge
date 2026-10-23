// A one-shot DOM observation. No page mutations or browser input.
function readBossPage() {
  const url = new URL(location.href);
  if (url.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(url.hostname)) {
    throw Error('只读取 https://www.zhipin.com 或 https://zhipin.com 的当前页面');
  }
  const limit = 40000;
  const chat = url.pathname === '/web/geek/chat' ? document.querySelector?.('.chat-conversation') : null;
  const text = (url.pathname === '/web/geek/chat' ?
    chat ? ['.top-info-content','.chat-record'].map(s=>chat.querySelector(s)?.innerText || '').join('\n') : '消息页：尚未选中会话' : document.body?.innerText || '').trim();
  const gateText = document.title + '\n' + (text.length < 1500 && !text.includes('职位描述') ? text : '');
  const blocker = /安全验证|访问异常|访问受限|请完成验证|拖动滑块/.test(gateText) ? 'verification_required' :
    /^\/(?:web\/user|user\/login)/.test(url.pathname) ? 'login_required' : null;
  const links = [];
  const identityLinks = [];
  const listingLinks = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const label = (a.innerText || '').trim(), r = a.getBoundingClientRect();
    if (!label || !r.width || !r.height) continue;
    try {
      const target = new URL(a.href);
      if (target.origin === 'https://www.zhipin.com' && (/^\/job_detail\//.test(target.pathname) || /^\/gongsi\//.test(target.pathname))) {
        if (identityLinks.length < 200) identityLinks.push({text: label.slice(0, 200), url: target.origin + target.pathname});
        if (a.closest?.('.job-card-box') && /^\/job_detail\/[^/]+\.html$/.test(target.pathname) && listingLinks.length<80) listingLinks.push({text:label.slice(0,200),url:target.origin+target.pathname});
      }
    } catch (_) { /* Invalid identity links are ignored. */ }
  }
  const more = identityLinks.find(link => link.text === '查看更多信息' && /\/job_detail\//.test(link.url));
  let selectedDetail = null;
  if (more) {
    const index = identityLinks.findIndex(link => link.url === more.url && link.text !== '查看更多信息');
    let company = null;
    for (const link of identityLinks.slice(index + 1)) {
      if (/\/job_detail\//.test(link.url)) break;
      if (/\/gongsi\//.test(link.url)) { company = link.text; break; }
    }
    selectedDetail = {url: more.url, title: index >= 0 ? identityLinks[index].text : null, company};
  }
  for (const a of document.querySelectorAll('a[href]')) {
    if (links.length >= 50) break;
    const r = a.getBoundingClientRect();
    const label = (a.innerText || '').trim();
    if (!label || !r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    try {
      const target = new URL(a.href);
      if (target.protocol === 'https:' && ['www.zhipin.com', 'zhipin.com'].includes(target.hostname)) {
        links.push({text: label.slice(0, 200), url: target.origin + target.pathname});
      }
    } catch (_) { /* Invalid links are not observations. */ }
  }
  const salaryRegions = [];
  if (/[\uE000-\uF8FF]/.test(text)) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, inspected = 0;
    while ((node = walker.nextNode()) && inspected++ < 20000) {
      let value = node.textContent.trim();
      if (!/[\uE000-\uF8FF]/.test(value) || value.length > 80) continue;
      let element = node.parentElement;
      if (!element) continue;
      // Salary glyphs may be split among several spans. Use the nearest small
      // salary-only ancestor instead of requiring one complete text node.
      let candidate = element;
      for (let depth = 0; candidate && depth < 3; depth++, candidate = candidate.parentElement) {
        const combined = (candidate.innerText || '').trim();
        if (combined.length > 80) break;
        if (/[\uE000-\uF8FF]/.test(combined) && /[Kk元]/.test(combined)) {element = candidate; value = combined; break;}
      }
      const range = document.createRange();
      range.selectNodeContents(element);
      const r = range.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight || style.visibility === 'hidden' || style.display === 'none') continue;
      if (salaryRegions.length < 50 && !salaryRegions.some(v => v.text === value && v.x === r.left && v.y === r.top)) salaryRegions.push({text: value, x: r.left, y: r.top, width: r.width, height: r.height});
    }
  }
  return {
    url: url.origin + url.pathname,
    title: document.title.slice(0, 500),
    text: text.slice(0, limit),
    truncated: text.length > limit,
    links,
    frames: document.querySelectorAll('iframe').length,
    ready: document.readyState,
    captured_at: new Date().toISOString(),
    scope: 'top_frame_rendered_dom',
    viewport: {width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY,
      document_id: globalThis.__bossDocumentId ||= (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : new Date().toISOString())},
    salary_regions: salaryRegions,
    selected_detail: selectedDetail,
    browser: typeof observeBossControls === 'function' ? observeBossControls() : null,
    jobs: [...new Map((url.pathname === '/web/geek/jobs' ? listingLinks : identityLinks).filter(link => /^https:\/\/www\.zhipin\.com\/job_detail\/[^/]+\.html$/.test(link.url) && link.text !== '查看更多信息').map(link => [link.url, link])).values()].slice(0, 80),
    navigation_url: typeof bossBrowseUrl === 'function' ? bossBrowseUrl(location.href) : url.origin + url.pathname,
    blocker,
  };
}
