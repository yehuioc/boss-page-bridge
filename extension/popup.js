// View/controller only. The worker is the sole owner of binding and operations.
const $ = id => document.getElementById(id);
let current;
function render(state) {
  current = state;
  $('connection').textContent = state.binding ? '后台已连接 Boss 页；关闭侧栏仍可继续，点立即停止结束接管。' : state.paired ? '本机配对保留；请连接当前 Boss 页。' : '尚未连接本机';
  $('status').textContent = state.message;
  const page = state.snapshot, job = page?.job;
  $('summary').textContent = job ? `${job.layout === 'list_detail' ? '列表内详情' : '独立详情页'} · ${job.title}\n${job.url}\n${job.warnings.join('\n')}` : page ? `${page.title}\n${page.url}` : '';
  if (page && !state.binding) $('summary').textContent = '上次读取（接管已停止，非当前页实时结果）\n' + $('summary').textContent;
  $('preview').value = job ? `职位：${job.title}\n公司：${job.company || '待核对'}\n薪资：${job.salary || '待视觉核对'}\n地点：${job.location || '待核对'}\n经验：${job.experience || '待核对'}\n学历：${job.education || '待核对'}\n\n岗位职责\n${job.duties || '未分段'}\n\n任职要求\n${job.requirements || '未分段'}\n\n职位描述原文\n${job.description}` : page?.text || '';
  $('salary-image').hidden = !page?.salary_image;
  if (page?.salary_image) $('salary-image').src = page.salary_image.data_url;
  else $('salary-image').removeAttribute('src');
  for (const id of ['connect','bind','read','focus']) $(id).disabled = state.busy;
  if ($('search-form')) renderSearch(state);
  if ($('inquiry-batches')) renderAssistant(state);
}
async function rpc(action, args = {}) {
  const reply = await chrome.runtime.sendMessage({action, args});
  if (reply?.error) throw Error(reply.error);
  if (!reply?.result) throw Error('后台没有返回状态，请重新打开侧栏');
  render(reply.result);
  return reply.result;
}
function button(id, action, args = () => ({})) {
  $(id).onclick = async () => {
    try {await rpc(action, args()); if (action === 'pair') $('code').value = '';}
    catch (error) {$('status').textContent = '未完成：' + error.message;}
  };
}
button('connect','pair',()=>({code:$('code').value.trim()}));
button('ping','ping'); button('bind','bind'); button('stop','stop'); button('read','read'); button('focus','focus');
const port = chrome.runtime.connect({name:'boss-panel'});
port.onMessage.addListener(render);
port.onDisconnect.addListener(()=>{$('connection').textContent='后台连接已中断；请重新打开侧栏检查，未自动重放操作。';});
rpc('state').catch(error=>{$('status').textContent=error.message;});

let formLoaded = false, formDirty = false, formProfileId = null, filtersSignature = '', resultSignature = '', exportUrl;
const selectedJobs = new Set();
function node(tag, text, parent) {const e=document.createElement(tag);if(text !== undefined)e.textContent=text;parent?.append(e);return e;}
function renderSearch(state) {
  const data=state.search, run=data?.run;
  const running=!!state.binding && (state.workflow_active || ['running','stopping'].includes(run?.status));
  $('search-start').disabled=!state.binding || running || state.busy;
  $('search-stop').disabled=!running;
  $('read').disabled=state.busy || running; $('focus').disabled=state.busy || running;
  if (!run) return;
  const newProfile=!formLoaded || (!formDirty && run.id!==formProfileId && run.id!=='library');
  if (newProfile) {
    const p=run.profile; $('keywords').value=p.keywords.join('，');$('city').value=p.city;
    $('remote').checked=p.remote;$('part-time').checked=p.part_time;$('education').value=p.education;
    $('years').value=p.experience_years;$('limit').value=p.limit;formLoaded=true;formProfileId=run.id;
  }
  const signature=JSON.stringify(data.filters);
  if (signature !== filtersSignature || newProfile) {
    filtersSignature=signature; const old=newProfile?{}:Object.fromEntries([...$('filters').querySelectorAll('select')].map(s=>[s.dataset.key,s.value]));
    $('filters').replaceChildren();
    for (const group of data.filters || []) {
      const label=node('label',group.label+' ',$('filters')), select=node('select',undefined,label);select.dataset.key=group.key;
      node('option','不限',select).value='';
      for (const option of group.options.filter(o=>o.value!=='0')) node('option',option.label,select).value=option.label;
      select.value=old[group.key] ?? run.profile.filters[group.key] ?? '';
    }
  }
  const candidates=Object.values(run.candidates || {}), counts={};
  for(const c of candidates)counts[c.assessment.status]=(counts[c.assessment.status]||0)+1;
  const p=run.profile, criteria=run.id==='library'?'':`本轮条件：${p.keywords.join('、')}；${p.city}；${p.education}；经验${p.experience_years}年${p.remote?'；必须远程':''}${p.part_time?'；兼职':''}；最多${p.limit}项。网站筛选：${Object.values(p.filters).join('、')||'不限'}`;
  $('search-status').textContent=(!state.binding && ['running','stopping'].includes(run.status)?'接管已停止，保留已读候选；重新连接不会自动续跑。':run.message)+'\n'+criteria+'\n'+Object.entries(counts).map(([k,v])=>k+' '+v).join(' · ')+(run.errors?.length?'\n有未能读取的详情，见导出结果。':'');
  const resultsKey=JSON.stringify([run.id,run.updated_at,!!state.binding,running,state.assistant?.assistant?.updated_at]);
  if (resultsKey===resultSignature)return;resultSignature=resultsKey;$('search-results').replaceChildren();
  const labels={role:'方向',remote:'远程',part_time:'兼职',education:'学历',experience:'经验'};
  const order={'符合已核对条件':0,'待核对':1,'不符合硬条件':2};
  const rank=c=>c.ai&&!c.ai.stale?({keep:0,ask_hr:1,conflict:2}[c.ai.decision]):order[c.assessment.status];
  for(const c of candidates.sort((a,b)=>rank(a)-rank(b))) {
    const article=node('article',undefined,$('search-results')), job=c.job,a=c.assessment;
    const choice=node('label',undefined,article),check=node('input',undefined,choice);check.type='checkbox';check.checked=selectedJobs.has(job.url);check.onchange=()=>{if(check.checked)selectedJobs.add(job.url);else selectedJobs.delete(job.url);};
    node('span',' 选择此岗位',choice);
    node('h3',job.title,article);node('p',(c.ai&&!c.ai.stale?c.ai.label:'尚未模型阅读；规则辅助：'+a.status)+' · '+(job.company||'公司待核对')+' · '+(job.salary||'薪资待核对'),article);
    if(c.ai) {
      const ai=c.ai;node('p',(ai.stale?'旧判断（JD已变化，须重新分析）：':'模型理解：')+ai.summary,article);node('p',ai.reason,article);
      if(ai.profile)node('p','分析条件：'+ai.profile.keywords.join('、')+(ai.profile.remote?'；远程':'')+(ai.profile.part_time?'；兼职':'')+'；'+ai.profile.education+'；经验'+ai.profile.experience_years+'年',article);
      const detail=node('details',undefined,article);node('summary','模型依据、未知项与问询建议',detail);
      for(const e of ai.evidence)node('blockquote',(e.source==='hr'?'HR回复':'JD')+'原文：'+e.quote+'\n'+e.meaning,detail);
      node('p','仍待核对：'+(ai.unknowns.join('；')||'暂无新增未知项'),detail);node('p','建议问：'+ai.questions.join('；'),detail);
    }
    if(c.profile)node('p','采集条件：'+c.profile.keywords.join('、')+'；'+c.profile.city+'；'+c.profile.education+'；经验'+c.profile.experience_years+'年'+(c.profile.remote?'；远程':'')+(c.profile.part_time?'；兼职':''),article);
    node('p',a.reasons.join('；') || '当前条件均有文字依据，仍需你核对实际安排。',article);
    const evidence=node('details',undefined,article);node('summary','查看依据与采集时间',evidence);
    for(const [k,f] of Object.entries(a.facts))node('blockquote',labels[k]+'：'+({yes:'有依据',no:'不符',unknown:'待核对',conflict:'有矛盾'}[f.state])+'\n'+f.quotes.join('\n'),evidence);
    node('p',a.notes.join('；'),evidence);node('p','采集：'+job.captured_at,evidence);
    const link=node('a','职位原页',evidence);link.href=job.url;link.target='_blank';link.rel='noopener noreferrer';
    const open=node('button','在已连接页打开',article);open.disabled=!state.binding||running;
    open.onclick=()=>rpc('open_candidate',{url:job.url}).catch(error=>{$('search-status').textContent=error.message;});
  }
}
if ($('search-form')) {
  $('search-form').oninput=()=>{formDirty=true;};
  $('search-form').onsubmit=async event=>{
    event.preventDefault();
    formDirty=false;formProfileId=null;
    const filters=Object.fromEntries([...$('filters').querySelectorAll('select')].filter(s=>s.value).map(s=>[s.dataset.key,s.value]));
    try {await rpc('search_start',{keywords:$('keywords').value.split(/[,，\n]/).map(k=>k.trim()).filter(Boolean),city:$('city').value.trim(),remote:$('remote').checked,part_time:$('part-time').checked,education:$('education').value,experience_years:Number($('years').value),limit:Number($('limit').value),filters,...($('model-auto')?.checked?{analyze:true}:{})});}
    catch(error){$('search-status').textContent=error.message;}
  };
  button('search-stop','search_stop');
  button('current-run','search_state');button('saved-jobs','search_library');
  for(const format of ['md','csv','json'])$('export-'+format).onclick=async()=>{
    try {
      const reply=await chrome.runtime.sendMessage({action:'search_export',args:{format}});
      if(reply.error)throw Error(reply.error);
      if(exportUrl)URL.revokeObjectURL(exportUrl);
      exportUrl=URL.createObjectURL(new Blob([reply.result.text],{type:'text/plain;charset=utf-8'}));
      const link=$('export-download');link.href=exportUrl;link.download='Boss候选核对.'+format;link.textContent='保存 '+format.toUpperCase()+' 文件';link.hidden=false;
    }catch(error){$('search-status').textContent=error.message;}
  };
  rpc('search_state').catch(error=>{$('search-status').textContent=error.message;});
}
let inquirySignature='',templateLoaded=false;
function currentProfile() {
  return {keywords:$('keywords').value.split(/[,，\n]/).map(k=>k.trim()).filter(Boolean),city:$('city').value.trim(),remote:$('remote').checked,
    part_time:$('part-time').checked,education:$('education').value,experience_years:Number($('years').value),limit:Number($('limit').value),
    filters:Object.fromEntries([...$('filters').querySelectorAll('select')].filter(s=>s.value).map(s=>[s.dataset.key,s.value]))};
}
function assistantError(error){$('inquiry-status').textContent='未完成：'+error.message;}
function renderAssistant(state) {
  const value=state.assistant,model=value?.assistant,queue=value?.inquiries;
  if(model)$('assistant-status').textContent=model.message+(model.status==='running'?'（已完成 '+(model.completed||0)+' 个）':'');
  if(!queue)return;
  $('inquiry-status').textContent=queue.message;
  if(!templateLoaded){$('inquiry-template').value=queue.template;templateLoaded=true;}
  const busy=['preparing','sending','stopping'].includes(queue.status)||state.workflow_active||state.busy;
  $('prepare-selected').disabled=!state.binding||busy;$('prepare-current').disabled=!state.binding||busy;
  $('analyze-selected').disabled=model?.status==='running'||model?.status==='stopping';
  const signature=JSON.stringify([queue.updated_at,!!state.binding,busy,model?.updated_at]);
  if(signature===inquirySignature)return;inquirySignature=signature;$('inquiry-batches').replaceChildren();
  for(const batch of [...queue.batches].reverse().slice(0,12)) {
    const article=node('article',undefined,$('inquiry-batches'));node('h3','问询批次 '+batch.id.slice(0,8)+' · '+batch.status,article);node('p',batch.message,article);
    for(const item of batch.items) {
      const block=node('div',undefined,article),id=item.identity;node('h4',id.job_title,block);
      node('p','HR：'+id.hr+' · '+id.company,block);
      if(id.job_url){const a=node('a','核对职位原页',block);a.href=id.job_url;a.target='_blank';a.rel='noopener noreferrer';}
      node('p',item.default_greeting?'确认后先发送 Boss 网站设置的默认招呼（内容由网站设置），再追加下列原文。':'已联系 HR：仅发送下列问询，不另发默认招呼。',block);
      node('blockquote',item.text,block);node('p',item.status+' · '+item.message,block);
      if(item.resume_draft)node('p','当前输入框已保留完全一致的原文；确认后发送此原文，不覆盖其他草稿。',block);
      if(item.status!=='preview') {
        const read=node('button','读取该 HR 回复',block);read.disabled=!state.binding||busy;read.onclick=()=>rpc('inquiry_replies',{batch_id:batch.id,item_id:item.id}).catch(assistantError);
        node('p','读取前在消息页选中此 HR；只读当前已加载文字，不自动续聊。',block);
      }
      if(item.replies?.length) {
        for(const reply of item.replies)node('blockquote','HR：'+reply.text,block);
        const analyze=node('button','分析这些回复并更新判断',block);analyze.disabled=model?.status==='running';analyze.onclick=()=>rpc('inquiry_analyze_replies',{batch_id:batch.id,item_id:item.id}).catch(assistantError);
      }
      const review=model?.results?.[item.analysis_url || id.job_url];
      if(review?.used_hr_replies) {node('p','结合回复：'+review.label+'；'+review.summary+'；'+review.reason,block);for(const e of review.evidence)node('blockquote',(e.source==='hr'?'HR':'JD')+'：'+e.quote,block);node('p','下一步建议（未发送）：'+review.questions.join('；'),block);}
    }
    if(batch.status==='preview') {
      node('p','确认仅对本批上述对象和原文有效；重连、超时或改内容须重新准备。',article);
      const approve=node('button','确认本批并发送（'+batch.items.length+' 个 HR）',article);approve.disabled=!state.binding||busy;
      approve.onclick=()=>rpc('inquiry_approve',{batch_id:batch.id,revision:batch.revision}).catch(assistantError);
    }
  }
}
if($('inquiry-batches')) {
  $('analyze-selected').onclick=()=>rpc('assistant_analyze',{urls:[...selectedJobs],profile:currentProfile()}).catch(error=>{$('assistant-status').textContent=error.message;});
  $('prepare-selected').onclick=()=>rpc('inquiry_prepare',{urls:[...selectedJobs],text:$('inquiry-template').value,profile:currentProfile()}).catch(assistantError);
  $('prepare-current').onclick=()=>rpc('inquiry_prepare',{urls:[],current:true,text:$('inquiry-template').value,profile:currentProfile()}).catch(assistantError);
  $('save-template').onclick=()=>rpc('inquiry_template',{text:$('inquiry-template').value}).catch(assistantError);
  $('model-auth').onclick=async()=>{try{const reply=await chrome.runtime.sendMessage({action:'assistant_auth',args:{}});if(reply.error)throw Error(reply.error);$('assistant-status').textContent=reply.result.message;}catch(error){$('assistant-status').textContent=error.message;}};
  rpc('assistant_state').catch(assistantError);
}
