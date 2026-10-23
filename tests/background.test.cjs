const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const flush=()=>new Promise(r=>setImmediate(r));
function event(){const listeners=[];return {addListener:f=>listeners.push(f),emit:(...args)=>listeners.forEach(f=>f(...args))};}
function fixture(saved = {}, options = {}) {
  const events=Object.fromEntries(['message','connect','alarm','startup','installed','removed','updated','action'].map(k=>[k,event()]));
  const timers=new Map(),requests=[],updates=[],scripts=[];let seq=0,command=null,held;
  const tab={id:12,windowId:3,url:'https://www.zhipin.com/web/geek/jobs',title:'职位',active:false,status:'complete',autoDiscardable:true};
  const sessionStore=structuredClone(saved);
  const page=()=>({url:tab.url.split('?')[0],navigation_url:tab.url,title:'职位',ready:'complete',text:'职位描述\n项目管理',links:[],jobs:[{url:'https://www.zhipin.com/job_detail/a.html',text:'项目管理'}],
    captured_at:new Date().toISOString(),job:null,browser:{key:crypto.randomUUID(),controls:options.accountPending?[]:[{ref:'c0',kind:'page_link',href:'https://www.zhipin.com/web/geek/recommend',label:options.account||'测试账号',context:'li.nav-figure > ul.user-nav'}]}});
  const chrome={runtime:{id:'a'.repeat(32),getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,getManifest:()=>({version:options.version||'0.5.0'}),onMessage:events.message,onConnect:events.connect,onStartup:events.startup,onInstalled:events.installed},
    action:{onClicked:events.action},sidePanel:{setPanelBehavior:async()=>{},open:async()=>{}},
    alarms:{create:async()=>{},clear:async()=>{},onAlarm:events.alarm},
    storage:{local:{get:async()=>({token:'test-token'}),set:async()=>{}},session:{get:async()=>sessionStore,set:async value=>Object.assign(sessionStore,structuredClone(value))}},
    windows:{get:async()=>({state:'minimized',focused:false}),update:async()=>{throw Error('Unexpected focus');}},
    tabs:{get:async()=>({...tab}),query:async()=>[tab],update:async(id,args)=>{updates.push({id,...args});Object.assign(tab,args);return {...tab};},reload:async()=>{},onRemoved:events.removed,onUpdated:events.updated},
    scripting:{executeScript:async config=>{scripts.push(config);if(config.files)return [{}];
      if(options.hold){return new Promise(resolve=>{held=resolve;});}
      return [{result:page()}];}}
  };
  const context=vm.createContext({chrome,crypto,URL,Date,AbortController,AbortSignal,structuredClone,
    setTimeout:(f,ms)=>{const id=++seq;timers.set(id,{f,ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,request)=>{
      const body=JSON.parse(request.body);requests.push({url,body});
      if(options.offline)throw Error('offline');
      let data={};
      if(url.endsWith('/ping'))data={message:'ok',server_id:options.serverId||'server-one'};
      if(url.endsWith('/poll')){data={server_id:options.serverId||'server-one',command:command&&!body.busy?command:null};if(data.command)command=null;
        if(options.cancel)data.cancel=options.cancel;
        if(options.workflow)data.workflow_active=true;
        if(options.raceStop){options.raceStop=false;context.pause('race stop');}}
      return {ok:true,json:async()=>data};
    }});
  context.importScripts=(...names)=>names.forEach(name=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',name),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
  return {context,events,requests,updates,scripts,sessionStore,timers,options,tab,page,
    async ready(){await context.init();await flush();},async tick(){await context.tick();await flush();await flush();},
    async bind(){await context.handle('bind');await flush();},
    queue(action='read'){const b=context.state().binding;command={id:crypto.randomUUID(),session:b.session,action,args:{},expires:Date.now()/1000+30};return command;},
    finish(){held?.([{result:page()}]);},
    panel(){const port={name:'boss-panel',sender:{id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')},onDisconnect:event(),postMessage(){},disconnect(){}};events.connect.emit(port);return port;}
  };
}
test('worker executes on a background tab without panel and preserves one grant when panels close',async()=>{
  const f=fixture();await f.ready();await f.bind();const before=f.context.state().binding;
  const port=f.panel();await flush();port.onDisconnect.emit();f.queue();await f.tick();
  assert.equal(f.context.state().binding.session,before.session);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/result')).length,1);
  assert.equal(f.updates.some(p=>p.active),false);
  assert.ok(f.scripts.every(s=>s.world==='ISOLATED'));
  await f.tick();
  assert.ok([...f.timers.values()].some(t=>t.ms===1500));
});
test('0.6 remote observation is tied to its exact command and workflow blocks local read',async()=>{
  const f=fixture({}, {version:'0.6.0'});await f.ready();await f.bind();
  const c=f.queue();await f.tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/snapshot')).at(-1).body.command_id,c.id);
  f.options.workflow=true;await f.tick();
  await assert.rejects(()=>f.context.handle('read'),/找岗任务正在浏览/);
  await f.context.handle('stop');assert.equal(f.context.state().binding,null);
});
test('busy jobs keep independent heartbeats and stop rejects a late observation',async()=>{
  const f=fixture();await f.ready();await f.bind();const initial=f.requests.filter(r=>r.url.endsWith('/snapshot')).length;
  f.options.hold=true;f.queue();await f.tick();assert.equal(f.context.state().busy,true);
  await f.tick();assert.equal(f.requests.filter(r=>r.url.endsWith('/poll')).at(-1).body.busy,true);
  await f.context.handle('stop');await flush();f.options.hold=false;f.finish();await flush();await flush();
  assert.equal(f.context.state().binding,null);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/snapshot')).length,initial);
  assert.match(f.requests.filter(r=>r.url.endsWith('/result')).at(-1).body.error,/停止/);
  assert.ok(f.updates.some(p=>p.autoDiscardable===true));
});
test('idle worker recreation retains same browser grant; interrupted job and browser restart never replay',async()=>{
  const f=fixture();await f.ready();await f.bind();
  const resumed=fixture(f.sessionStore);await resumed.ready();assert.equal(resumed.context.state().binding.session,f.context.state().binding.session);
  const crashed=structuredClone(f.sessionStore);crashed.bossRunner.flight={id:'interrupted'};
  const recovery=fixture(crashed);await recovery.ready();assert.equal(recovery.context.state().binding,null);
  assert.equal(recovery.scripts.length,0);assert.match(recovery.context.state().message,/未重放/);
  const reboot=fixture();await reboot.ready();assert.equal(reboot.context.state().binding,null);
});
test('server restart, offline connection, account drift and frozen tabs stop instead of reacquiring',async()=>{
  const f=fixture();await f.ready();await f.bind();
  const restarted=fixture(f.sessionStore,{serverId:'server-two'});await restarted.ready();assert.equal(restarted.context.state().binding,null);
  const changed=fixture(f.sessionStore,{account:'另一个账号'});await changed.ready();assert.equal(changed.context.state().binding,null);
  f.options.offline=true;await f.tick();assert.equal(f.context.state().binding,null);
  for(const field of ['discarded','frozen']){const other=fixture();await other.ready();await other.bind();other.tab[field]=true;await other.tick();assert.equal(other.context.state().binding,null);assert.equal(other.updates.some(p=>p.active),false);}
});
test('stop racing heartbeat delivery cannot run its command and unknown callers cannot gain control',async()=>{
  const f=fixture();await f.ready();await f.bind();const initial=f.requests.filter(r=>r.url.endsWith('/snapshot')).length;
  f.queue();f.options.raceStop=true;await f.tick();assert.equal(f.context.state().binding,null);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/snapshot')).length,initial);
  let replied=false;f.events.message.emit({action:'bind'},{id:'evil',url:'https://www.zhipin.com/'},()=>{replied=true;});await flush();assert.equal(replied,false);
  await assert.rejects(()=>f.context.handle('send_message'),/未开放/);
});
test('stop while binding is still observing cannot resurrect authorization',async()=>{
  const f=fixture();await f.ready();f.options.hold=true;
  const pending=f.context.handle('bind');await flush();await f.context.handle('stop');f.options.hold=false;f.finish();
  await assert.rejects(pending,/连接过程已被停止/);assert.equal(f.context.state().binding,null);
});
test('expired or cancelled commands abort only once and stop stays visible with no panels',async()=>{
  const f=fixture();await f.ready();await f.bind();f.options.hold=true;const c=f.queue();await f.tick();
  f.options.cancel=c.id;await f.tick();await flush();assert.equal(f.context.state().binding,null);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/result')).length,1);
  f.options.hold=false;f.finish();await flush();assert.equal(f.requests.filter(r=>r.url.endsWith('/result')).length,1);
  assert.ok(f.requests.some(r=>r.url.endsWith('/revoke')));
});
test('job content arriving before account navigation waits instead of revoking the grant',async()=>{
  const f=fixture();await f.ready();await f.bind();const session=f.context.state().binding.session;
  f.options.accountPending=true;f.queue();await f.tick();assert.equal(f.context.state().busy,true);
  assert.equal(f.context.state().binding.session,session);
  f.options.accountPending=false;
  const waiting=[...f.timers.values()].find(t=>t.ms===250);assert.ok(waiting);waiting.f();
  await flush();await flush();await flush();
  assert.equal(f.context.state().binding.session,session);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/result')).at(-1).body.error,null);
});
test('obsolete tab-change events do not revoke a healthy page, but confirmed foreign and frozen tabs stop',async()=>{
  const f=fixture();await f.ready();await f.bind();const session=f.context.state().binding.session;
  f.events.updated.emit(12,{url:'about:blank',frozen:true});await flush();await flush();
  assert.equal(f.context.state().binding.session,session);
  f.tab.url='https://example.com/';f.events.updated.emit(12,{url:f.tab.url});await flush();await flush();
  assert.equal(f.context.state().binding,null);assert.match(f.context.state().message,/example.com/);
  const other=fixture();await other.ready();await other.bind();other.tab.frozen=true;other.events.updated.emit(12,{frozen:true});await flush();await flush();
  assert.equal(other.context.state().binding,null);assert.match(other.context.state().message,/frozen/);
});
