const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function fixture(){
  const text=value=>({innerText:value,textContent:value});
  const shape={isConnected:true,getBoundingClientRect:()=>({left:0,top:0,right:200,bottom:50,width:200,height:50})};
  const span=(value,cls='')=>({...text(value),classList:{contains:k=>cls===k}});
  const name=span('测试HR','name-text'),company=span('测试公司');
  const editor={...shape,innerText:'',_value:'',get textContent(){return this._value;},set textContent(value){this._value=value;this.innerText=value;},dispatchEvent(){}};
  let sends=0;
  const send={...shape,classList:{contains:()=>false},getAttribute:()=>null,contains:()=>false,click:()=>sends++};
  const rows=[];
  const root={querySelector:s=>({'.base-info .name-text':name,'.position-name':text('账号运营'),'.position-content a[href]':null,
    '#chat-input[contenteditable="true"]':editor,'.chat-op button.btn-send':send}[s]||null),querySelectorAll:()=>rows};
  const selected={querySelector:s=>({'.name-box':{querySelectorAll:()=>[name,company]},'.name-text':name,
    '.figure img':{getAttribute:()=> 'https://img.bosszhipin.com/avatar/person_s.jpeg.webp'}}[s])};
  const document={body:text('chat'),querySelector:s=>({'.chat-conversation':root,'.chat-user .friend-content.selected':selected,
    '.chat-conversation #chat-input[contenteditable="true"]':editor,'.chat-conversation .chat-op button.btn-send':send}[s]||null),
    querySelectorAll:()=>[],elementFromPoint:()=>send};
  const context=vm.createContext({URL,location:{href:'https://www.zhipin.com/web/geek/chat',pathname:'/web/geek/chat'},document,innerWidth:1200,innerHeight:800,
    getComputedStyle:()=>({display:'block',visibility:'visible'}),InputEvent:class {},readBossPage:()=>({}),extractBossJob:()=>null});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/conversation.js'),'utf8'),context);
  const identity=JSON.parse(JSON.stringify(context.readBossConversation().identity));
  return {context,editor,send,document,identity,name,rows,sends:()=>sends};
}
test('selected HR identity uses rendered company, name, avatar and job, without hidden page state',()=>{
  const f=fixture(),c=f.context.readBossConversation();
  assert.equal(c.identity_complete,true);assert.equal(c.identity.company,'测试公司');
  assert.equal(c.identity.avatar,'https://img.bosszhipin.com/avatar/person.jpeg');
  f.name.innerText='另一个HR';f.name.textContent='另一个HR';
  assert.equal(f.context.bossIdentityEqual(f.identity,f.context.readBossConversation().identity),false);
});
test('wrong HR or job, nonempty draft and occlusion prevent send',async()=>{
  for(const change of ['hr','company','avatar','job_title','draft','covered']){
    const f=fixture(),expected={...f.identity};
    if(['hr','company','avatar','job_title'].includes(change))expected[change]+='wrong';
    if(change==='draft')f.editor.textContent='用户自己的草稿';
    if(change==='covered')f.document.elementFromPoint=()=>({});
    const args={identity:expected,text:'请问支持远程兼职吗？'};
    const prepared=f.context.prepareBossInquirySend(args);
    const r=prepared.error?prepared:await f.context.performBossInquiry('inquiry_send',args);
    assert.ok(r.error,change);assert.equal(f.sends(),0,change);
    if(change==='draft')assert.equal(f.editor.textContent,'用户自己的草稿');
  }
});
test('approved text goes through input event and only the exact send button',async()=>{
  const f=fixture(),args={identity:f.identity,text:'请问支持远程兼职吗？'};
  assert.equal(f.context.prepareBossInquirySend(args).ok,true);assert.equal(f.sends(),0);
  const r=await f.context.performBossInquiry('inquiry_send',args);
  assert.equal(r.ok,true);assert.equal(f.editor.textContent,'请问支持远程兼职吗？');assert.equal(f.sends(),1);
});
test('resume, phone and WeChat actions are absent even on a valid selected conversation',async()=>{
  const f=fixture();for(const action of ['send_resume','exchange_phone','exchange_wechat','click','input']){
    assert.match((await f.context.performBossInquiry(action,{identity:f.identity})).error,/未开放/);
  }assert.equal(f.sends(),0);
});
test('delayed enabled button keeps fill separate from send and records a definite pre-click refusal',async()=>{
  const f=fixture(),args={identity:f.identity,text:'请问支持远程兼职吗？'};
  f.send.classList.contains=()=>true;
  assert.equal(f.context.prepareBossInquirySend(args).ok,true);
  assert.equal(f.context.readBossConversation().send_available,false);
  assert.match((await f.context.performBossInquiry('inquiry_send',args)).error,/^发送前未点击：/);
  assert.equal(f.sends(),0);
  f.send.classList.contains=()=>false;
  assert.equal(f.context.readBossConversation().send_available,true);
  assert.equal((await f.context.performBossInquiry('inquiry_send',args)).ok,true);
  assert.equal(f.sends(),1);
});
test('resuming a draft compares exact approved text and never replaces other content',()=>{
  const f=fixture();f.editor.textContent='用户其他草稿';
  const args={identity:f.identity,text:'批准原文',resume_draft:true};
  assert.match(f.context.prepareBossInquirySend(args).error,/其他草稿/);
  assert.equal(f.editor.textContent,'用户其他草稿');assert.equal(f.sends(),0);
  f.editor.textContent='批准原文';
  assert.equal(f.context.checkBossInquiryDraft(args).ok,true);
  assert.equal(f.context.readBossConversation().draft_matches,true);
  assert.equal(f.context.prepareBossInquirySend(args).ok,true);
  assert.equal(f.editor.textContent,'批准原文');assert.equal(f.sends(),0);
});
test('only the observed part-time decoration is normalized; actual job title changes still mismatch',()=>{
  const f=fixture();assert.equal(f.context.bossJobTitle('兼职·账号运营'),'账号运营');
  assert.equal(f.context.bossJobTitle('账号运营主管'),'账号运营主管');
  assert.equal(f.context.bossIdentityEqual(f.identity,{...f.identity,job_title:'账号运营主管'}),false);
});
test('delivery receipt is never included in the message text used for exact send verification',()=>{
  const f=fixture();f.rows.push({getAttribute:()=> '123456',classList:{contains:k=>k==='item-myself'},
    querySelector:s=>s==='.message-content > .text .text-content'?{innerText:'批准原文'}:s==='.message-content > .text'?{innerText:'送达\n\n批准原文'}:null});
  const c=f.context.readBossConversation();assert.equal(c.messages[0].text,'批准原文');assert.equal(c.messages[0].direction,'me');
});
