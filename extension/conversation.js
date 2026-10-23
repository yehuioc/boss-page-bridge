// Fixed DOM adapter. Generic browse controls never gain messaging privileges.
function bossText(node, limit = 500) {return (node?.innerText || node?.textContent || '').trim().slice(0,limit);}
function bossJobTitle(value) {return value.replace(/^兼职·/,'').trim();}
function bossAvatar(raw) {
  try {
    const u=new URL(raw,location.href);
    if (!['img.bosszhipin.com','img2.bosszhipin.com'].includes(u.hostname) || !/avatar/.test(u.pathname)) return '';
    return u.origin+u.pathname.replace(/_(s|m|b)(?=\.)/,'').replace(/\.webp$/,'');
  } catch (_) {return '';}
}
function bossVisible(element) {
  if (!element?.isConnected) return false;
  const r=element.getBoundingClientRect(),s=getComputedStyle(element);
  return !!r.width && !!r.height && s.display!=='none' && s.visibility!=='hidden';
}
function bossIdentityEqual(a,b) {
  return !!a && !!b && ['hr','company','avatar','job_title'].every(k=>a[k] && a[k]===b[k]) && (!a.job_url || !b.job_url || a.job_url===b.job_url);
}
function bossGreetingDialog() {
  const heading=[...document.querySelectorAll('h2,h3,h4,div,span')].find(e=>bossText(e)==='已向BOSS发送消息');
  for(let p=heading?.parentElement;p&&p!==document.body;p=p.parentElement) {
    const labels=[...p.querySelectorAll('a,button,span,[role="button"]')].map(e=>bossText(e));
    if(labels.includes('留在此页')&&labels.includes('继续沟通'))return p;
  }
  return null;
}
function readBossConversation() {
  if(location.pathname!=='/web/geek/chat')return null;
  const root=document.querySelector('.chat-conversation'), selected=document.querySelector('.chat-user .friend-content.selected');
  if (!root || !selected) return null;
  const hr=bossText(root.querySelector('.base-info .name-text'),100);
  const name=selected.querySelector('.name-box'), spans=[...(name?.querySelectorAll('span')||[])];
  const company=bossText(spans.find(s=>!s.classList.contains('name-text') && bossText(s)!==hr),150);
  const avatar=bossAvatar(selected.querySelector('.figure img')?.getAttribute('src'));
  const title=bossJobTitle(bossText(root.querySelector('.position-name'),300));
  const link=root.querySelector('.position-content a[href]');
  const job_url=link && /^https:\/\/www\.zhipin\.com\/job_detail\/[^/]+\.html$/.test(bossBrowseUrl(link.href)||'') ? bossBrowseUrl(link.href):null;
  const rows=[...root.querySelectorAll('.chat-record .im-list > li.message-item')];
  const messages=rows.slice(-80).map(e=>({id:(e.getAttribute('data-mid')||'').slice(0,100),
    direction:e.classList.contains('item-friend')?'hr':e.classList.contains('item-myself')||e.classList.contains('item-self')?'me':'system',
    text:bossText(e.querySelector('.message-content > .text .text-content') || e.querySelector('.message-content > .text p'),3000),
    failed:!!e.querySelector('.send-error,.error,.resend,.icon-resend')})).filter(m=>m.id && m.text);
  const editor=root.querySelector('#chat-input[contenteditable="true"]'),send=root.querySelector('.chat-op button.btn-send');
  const selectedName=bossText(selected.querySelector('.name-text'),100);
  return {identity:{hr,company,avatar,job_title:title,job_url},messages,composer_empty:!!editor && !bossText(editor,10000),
    editor_available:bossVisible(editor),send_available:bossVisible(send)&&!send.disabled&&!send.classList.contains('disabled'),
    identity_complete:!!(hr && hr===selectedName && company && avatar && title),truncated:rows.length>80,
    draft_matches:!!editor && !!globalThis.__bossExpectedDraft && bossIdentityEqual(globalThis.__bossExpectedDraft.identity,{hr,company,avatar,job_title:title,job_url}) && bossText(editor,10000)===globalThis.__bossExpectedDraft.text};
}
function readBossRecruiter(job) {
  if(!job)return null;
  // Dedicated-detail and inline-detail pages use separate containers.
  const containers=[...document.querySelectorAll('.job-boss-info,.boss-info,.job-detail .boss-info,.job-detail-container .boss-info')].filter(bossVisible);
  for(const root of containers) {
    const hr=bossText(root.querySelector('.boss-name,.name,h2,h3'),100).replace(/\s*(在线|刚刚活跃|今日活跃|\d+分钟前活跃).*$/,'').trim();
    const avatar=bossAvatar(root.querySelector('img')?.getAttribute('src'));
    const dialog=bossGreetingDialog();
    const buttons=[...document.querySelectorAll('a,button')].filter(e=>bossVisible(e)&&!dialog?.contains(e)&&/^(立即沟通|继续沟通)$/.test(bossText(e)));
    if(hr && avatar && job.company && buttons.length===1)return {identity:{hr,company:job.company,avatar,job_title:bossJobTitle(job.title),job_url:job.url},
      contact_label:bossText(buttons[0]),default_greeting:bossText(buttons[0])==='立即沟通'};
  }
  return null;
}
function readBossInteraction(job) {
  const conversation=readBossConversation(),recruiter=readBossRecruiter(job);
  const greeting=bossGreetingDialog();
  return {conversation,recruiter,greeting_visible:!!greeting};
}
function bossRequireIdentity(expected, mode) {
  const page=readBossPage(),job=extractBossJob(page),view=readBossInteraction(job);
  const current=mode==='conversation'?view.conversation?.identity:view.recruiter?.identity;
  if(!bossIdentityEqual(expected,current))throw Error('HR、公司或职位身份不一致；未操作');
  return {page,job,view};
}
function bossClickExact(element) {
  if(!bossVisible(element)||element.disabled||element.classList.contains('disabled')||element.getAttribute('aria-disabled')==='true')throw Error('目标控件不可用');
  const r=element.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
  if(x<0||y<0||x>innerWidth||y>innerHeight)throw Error('目标控件不在当前视口，未点击');
  const top=document.elementFromPoint(x,y);
  if(top!==element&&!element.contains(top))throw Error('目标控件被遮挡，未点击');
  element.click();
}
function checkBossInquiryDraft(args) {
  try {
    bossRequireIdentity(args.identity,'conversation');
    globalThis.__bossExpectedDraft={identity:args.identity,text:args.text};
    return {ok:true};
  }catch(error){return {error:error.message};}
}
function prepareBossInquirySend(args) {
  try {
    const {view}=bossRequireIdentity(args.identity,'conversation');
    if(!view.conversation.identity_complete)throw Error('身份不完整');
    if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)throw Error('问询文本无效');
    if(view.conversation.messages.some(m=>m.direction==='me'&&m.text===args.text))throw Error('会话已有相同问询，未重复发送');
    const editor=document.querySelector('.chat-conversation #chat-input[contenteditable="true"]');
    if(!view.conversation.composer_empty) {
      if(!args.resume_draft||bossText(editor,10000)!==args.text)throw Error('输入框已有其他草稿，未覆盖');
    }else {
      editor.textContent=args.text;editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:args.text}));
    }
    globalThis.__bossExpectedDraft={identity:args.identity,text:args.text};
    return {ok:true};
  }catch(error){return {error:'发送前未点击：'+error.message};}
}
async function performBossInquiry(action,args) {
  let mayHaveClicked=false;
  try {
    if(action==='inquiry_contact') {
      const {view}=bossRequireIdentity(args.identity,'recruiter');
      if(view.recruiter.contact_label!==args.label)throw Error('沟通按钮状态改变，须重新预览');
      const dialog=bossGreetingDialog();
      const buttons=[...document.querySelectorAll('a,button')].filter(e=>bossVisible(e)&&!dialog?.contains(e)&&bossText(e)===args.label);
      if(buttons.length!==1)throw Error('沟通按钮不唯一');
      bossClickExact(buttons[0]);return {ok:true};
    }
    if(action==='inquiry_continue') {
      bossRequireIdentity(args.identity,'recruiter');
      if(!readBossInteraction(null).greeting_visible)throw Error('未出现已发送招呼的确认框');
      const buttons=[...bossGreetingDialog().querySelectorAll('a,button,span,[role="button"]')].filter(e=>bossVisible(e)&&bossText(e)==='继续沟通' &&
        ![...e.querySelectorAll('a,button,span,[role="button"]')].some(c=>bossText(c)==='继续沟通'));
      if(buttons.length!==1)throw Error('继续沟通按钮不唯一');
      bossClickExact(buttons[0]);return {ok:true};
    }
    if(action==='inquiry_send') {
      const {view}=bossRequireIdentity(args.identity,'conversation');
      if(!view.conversation.identity_complete)throw Error('身份不完整');
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)throw Error('问询文本无效');
      // Every attempt observes fresh message IDs; never count an old identical bubble as delivery.
      if(view.conversation.messages.some(m=>m.direction==='me'&&m.text===args.text))throw Error('会话已有相同问询，未重复发送');
      const editor=document.querySelector('.chat-conversation #chat-input[contenteditable="true"]');
      if(bossText(editor,10000)!==args.text)throw Error('输入框未保留批准的原文');
      // Recheck synchronously after editing, immediately before the external side effect.
      bossRequireIdentity(args.identity,'conversation');
      const send=document.querySelector('.chat-conversation .chat-op button.btn-send');
      if(!bossVisible(send)||send.disabled||send.classList.contains('disabled'))throw Error('目标控件不可用');
      const r=send.getBoundingClientRect(),top=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
      if(top!==send&&!send.contains(top))throw Error('目标控件被遮挡');
      mayHaveClicked=true;
      bossClickExact(send);return {ok:true};
    }
    throw Error('未开放此沟通动作');
  }catch(error){return {error:(action==='inquiry_send'&&!mayHaveClicked?'发送前未点击：':'')+error.message};}
}
