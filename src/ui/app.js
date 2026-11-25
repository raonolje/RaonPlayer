import {RemoteEngine as PlaybackEngine} from './remote-engine.js';

const $=id=>document.getElementById(id);
const sources=[['pgm','PGM'],['pvw','PVW'],['layer0','레이어 01'],['layer1','레이어 02'],['layer2','레이어 03'],['layer3','레이어 04']];
const fmt=(value=0)=>{const n=Math.max(0,Number(value)||0);return `${String(Math.floor(n/60)).padStart(2,'0')}:${(n%60).toFixed(3).padStart(6,'0')}`;};
const sourceLabel=key=>sources.find(([s])=>s===key)?.[1]||'10뷰 격자';
const uuid=()=>crypto.randomUUID();
const initial=()=>({schema:'raon-player/1',name:'새 공연',media:[],cues:[],layers:Array.from({length:4},()=>({opacity:1,enabled:true,mute:true,fit:'contain',x:0,y:0,scale:1})),output:{width:1920,height:1080,fps:60},views:Array.from({length:10},(_,i)=>i===0?'pgm':i===1?'pvw':`layer${(i-2)%4}`)});

init().catch(e=>{console.error(e);$('statusMessage').textContent=e.message;$('statusMessage').className='error';});

async function init(){
 let state=initial(),selectedId=null,dirty=false,locked=false,busy=false,prepareSerial=0,autoPending=false,pendingAuto=null,projectSerial=0,followingAuto=false;
 let environment=await window.native.environment();
 const outputWindows=new Map();
 const engine=new PlaybackEngine($('pgm'),$('pvw'),state.layers,state.output);
 await engine.init();engine.sync(state,locked);
 const selected=()=>state.cues.find(c=>c.id===selectedId);
 const mediaById=id=>state.media.find(m=>m.id===id);
 const activeIds=()=>new Set(engine.active.filter(Boolean).map(d=>d.cue.id));
 let queueOrder=null;const queueRows=new Map();
 const status=(message,error=false)=>{$('statusMessage').textContent=message;$('statusMessage').className=error?'error':'';};
 let autosaveTimer;
 const mark=()=>{engine.sync(state,locked);dirty=true;$('dirtyStatus').textContent='저장되지 않은 변경';clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>window.native.autosave(state).then(()=>{$('dirtyStatus').textContent='자동 저장됨 · 프로젝트 저장 권장';}).catch(e=>status(e.message,true)),900);};
 const error=e=>{console.error(e);status(e.message||String(e),true);};
 const action=fn=>async(...args)=>{try{return await fn(...args);}catch(e){error(e);}};
 window.playerShared={source:key=>engine.source(key),views:()=>state.views,sourceLabel,outputFullscreen:(id,full)=>window.native.outputFullscreen(id,full),info:()=>({output:state.output,fps:engine.fps,active:engine.active.map(d=>d?.cue.name||null)})};
 // Expose deterministic operations for local diagnostics and acceptance tests.
 window.playerDiagnostics={getState:()=>structuredClone(state),getEngine:()=>engine,addMedia:items=>addMedia(items),select:async id=>selectCue(id),go:()=>go(),loadProject:project=>loadProject(project),readPixel:(x,y)=>engine.command('pixel',{x,y})};
 engine.onError=e=>{error(e);$('programState').textContent='HOLD / ERROR';};
 const pumpAuto=async()=>{
  if(!pendingAuto||autoPending||busy||locked)return;
  const deck=pendingAuto;pendingAuto=null;
  const index=state.cues.findIndex(c=>c.id===deck.cue.id),next=index<0?null:state.cues[index+1];
  if(!next||!engine.active.includes(deck))return;
  const serial=projectSerial,generation=engine.generation||0;autoPending=true;
  try{if(selectedId!==next.id||!engine.prepared?.ready)await selectCue(next.id);if(serial===projectSerial&&generation===(engine.generation||0)&&!locked&&engine.active.includes(deck))await go();}
  catch(e){error(e);}finally{autoPending=false;if(pendingAuto)queueMicrotask(pumpAuto);}
 };
 engine.onState=()=>{renderQueue();renderLayers();if(followingAuto&&engine.prepared){selectedId=engine.prepared.cue.id;inspector();$('previewTitle').textContent=engine.prepared.cue.name;$('readyState').textContent='READY';$('readyState').className='status ready';$('go').disabled=locked;}};
 engine.onAuto=cue=>{followingAuto=true;const index=state.cues.findIndex(c=>c.id===cue.id);selectedId=state.cues[index+1]?.id||cue.id;renderQueue();renderLayers();inspector();$('programTitle').textContent=cue.name;$('programState').textContent='ON AIR';$('readyState').textContent=state.cues[index+1]?'PREPARING':'END OF CUES';};
 engine.onEnd=deck=>{if(!deck.cue.auto||locked)return;pendingAuto=deck;void pumpAuto();};
 function renderLibrary(){
  const list=$('mediaList');list.replaceChildren();
  state.media.filter(m=>!m.cache&&!m.name.startsWith('↔ ')).forEach(m=>{
   const item=document.createElement('div');item.className='media-item'+(m.missing?' missing':'');
   const title=document.createElement('strong');title.textContent=(m.kind==='image'?'▧ ':'▷ ')+m.name;title.title=m.path;
   const info=document.createElement('p');info.textContent=m.missing?'파일 누락 · 다시 연결 필요':`${m.width||'?'} × ${m.height||'?'} · ${m.kind==='image'?'IMAGE':fmt(m.duration)}\n${m.codec||'기본 디코더'}${m.alpha?' · ALPHA':''}`;info.style.whiteSpace='pre-line';
   const actions=document.createElement('div');actions.className='actions';
   const add=document.createElement('button');add.className='small accent';add.textContent=m.missing?'다시 연결':'＋ 큐 추가';
   add.onclick=action(async()=>{if(m.missing){const replacement=await window.native.relink(m.id);if(replacement){Object.assign(m,replacement);for(const c of state.cues)if(c.mediaId===m.id)c.playbackMediaId=null;renderLibrary();renderQueue();if(selected()?.mediaId===m.id)await selectCue(selectedId);mark();}}else addCue(m);});
   actions.append(add);
   if(m.kind==='video'&&!m.missing&&environment.ffmpeg){const convert=document.createElement('button');convert.className='small';convert.textContent='호환 변환';convert.title='로컬에서 H.264 MP4 또는 알파 VP9 WebM 호환본 생성';convert.onclick=action(async()=>{
    $('job').querySelector('h2').textContent='공연용 호환 포맷 변환';$('job').querySelector('p').textContent='원본을 유지하고 로컬 호환본을 만듭니다. 알파는 VP9 WebM으로 보존하며, 일반 영상은 H.264 MP4로 변환합니다.';$('job').showModal();$('jobProgress').textContent='로컬 변환 준비 중…';
    try{const result=await window.native.transcode(m.id);await addMedia([result]);status('호환본을 미디어에 추가했습니다. 새 큐로 추가해 사용하세요.');}finally{$('job').close();}
   });actions.append(convert);}
   item.append(title,info,actions);list.append(item);
  });$('mediaCount').textContent=state.media.filter(m=>!m.cache&&!m.name.startsWith('↔ ')).length+'개 파일';
 }
 function renderQueue(){
  const body=$('cueList'),order=state.cues.map(c=>c.id).join('|'),live=activeIds();
  if(order!==queueOrder){body.replaceChildren();queueRows.clear();queueOrder=order;
   for(const c of state.cues){const row=document.createElement('tr');row.dataset.id=c.id;for(let i=0;i<6;i++)row.append(document.createElement('td'));row.onclick=action(()=>selectCue(c.id));queueRows.set(c.id,row);body.append(row);}
  }
  state.cues.forEach((c,i)=>{
   const row=queueRows.get(c.id),className=[c.id===selectedId?'selected':'',live.has(c.id)?'onair':''].join(' ');if(row.className!==className)row.className=className;
   const label=mediaById(c.mediaId)?.missing?'MISSING':engine.prepared?.cue.id===c.id?'READY':live.has(c.id)?'ON AIR':c.mode==='pingpong'&&!c.playbackMediaId?'CACHE':'STANDBY';
   const values=[String(i+1).padStart(2,'0'),c.name,'L'+(c.layer+1),`${fmt(c.in)} → ${fmt(c.out)}`,c.mode==='once'?'한 번':c.mode==='loop'?'구간 반복':'핑퐁 ↔',label];
   values.forEach((v,index)=>{const td=row.children[index];if(td.textContent!==v)td.textContent=v;if(index===5){const cls=label==='READY'?'ready':label==='MISSING'?'error':'';if(td.className!==cls)td.className=cls;}});
  });$('queueEmpty').hidden=state.cues.length>0;$('cueCount').textContent=String(state.cues.length);
 }
 function inspector(){
  const c=selected();const fields=['cueName','cueLayer','cueIn','cueOut','cueMode','cueAuto'];fields.forEach(id=>$(id).disabled=!c);
  $('prepareLoop').disabled=!c||c.mode!=='pingpong'||!!c.playbackMediaId||!environment.ffmpeg;
  if(!c){$('selectedName').textContent='선택된 큐 없음';return;}
  $('cueName').value=c.name;$('cueLayer').value=String(c.layer);$('cueIn').value=c.in;$('cueOut').value=c.out;$('cueMode').value=c.mode;$('cueAuto').checked=c.auto;
   $('selectedName').textContent=c.name;$('cacheState').textContent=c.mode==='pingpong'?(c.playbackMediaId?'핑퐁 캐시 준비됨 · 영상 전용':'핑퐁 캐시를 먼저 생성하세요'):c.mode==='loop'?'반복 프레임을 미리 준비합니다 · READY 후 GO':'구간 편집은 다음 GO에 반영됩니다';
 }
 function renderLayers(){
  const list=$('layerList');list.replaceChildren();
  state.layers.forEach((layer,i)=>{
   const item=document.createElement('section');item.className='layer-item';
   const head=document.createElement('div');head.className='layer-head';const title=document.createElement('strong');title.textContent=`${String(i+1).padStart(2,'0')} · ${i===0?'배경':i===3?'최상단':'레이어'}`;
   const enable=document.createElement('input');enable.type='checkbox';enable.checked=layer.enabled;enable.disabled=locked;enable.title='레이어 표시';enable.onchange=()=>{layer.enabled=enable.checked;mark();};head.append(title,enable);
   const name=document.createElement('div');name.className='layer-name';name.id=`layerName${i}`;name.textContent=engine.active[i]?.cue.name||'비어 있음';
   const controls=document.createElement('div');controls.className='layer-controls';const opacity=document.createElement('input');opacity.type='range';opacity.min='0';opacity.max='1';opacity.step='.01';opacity.value=layer.opacity;opacity.disabled=locked;opacity.setAttribute('aria-label',`레이어 ${i+1} 불투명도`);
   const value=document.createElement('output');value.textContent=Math.round(layer.opacity*100)+'%';opacity.oninput=()=>{layer.opacity=Number(opacity.value);value.textContent=Math.round(layer.opacity*100)+'%';mark();};controls.append(opacity,value);
   const row=document.createElement('div');row.className='layer-row';
   const fitLabel=document.createElement('label');fitLabel.textContent='맞춤';const fit=document.createElement('select');for(const [v,l] of [['contain','FIT'],['cover','FILL / CROP'],['stretch','STRETCH']]){const o=new Option(l,v);fit.add(o);}fit.value=layer.fit;fit.disabled=locked;fit.onchange=()=>{layer.fit=fit.value;mark();};fitLabel.append(fit);
   const muteLabel=document.createElement('label');muteLabel.className='check';const mute=document.createElement('input');mute.type='checkbox';mute.checked=layer.mute;mute.disabled=locked;mute.onchange=()=>{layer.mute=mute.checked;engine.active[i]?.setMuted(layer.mute);mark();};muteLabel.append(mute,'음소거');row.append(fitLabel,muteLabel);
   const transform=document.createElement('div');transform.className='layer-row layer-transform';
   for(const [key,label,min,max,step] of [['x','X · px',-16384,16384,1],['y','Y · px',-16384,16384,1],['scale','크기 배율',.05,4,.01]]){const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step=step;input.value=layer[key];input.disabled=locked;input.onchange=()=>{layer[key]=Math.min(max,Math.max(min,Number(input.value)||0));input.value=layer[key];mark();};l.append(input);transform.append(l);}
   const clear=document.createElement('button');clear.textContent='레이어 비우기';clear.className='small';clear.disabled=locked;clear.onclick=()=>{engine.active[i]?.dispose();engine.active[i]=null;renderLayers();renderQueue();};transform.append(clear);
   item.append(head,name,controls,row,transform);list.append(item);
  });
 }
 async function addMedia(items){
  const errors=[];for(const item of items){if(item.error){errors.push(`${item.name}: ${item.error}`);continue;}const existing=state.media.find(m=>m.path===item.path);if(!existing)state.media.push(item);}
  renderLibrary();mark();status(errors.length?errors.join(' / '):'미디어를 불러왔습니다. 큐에 추가하세요.',!!errors.length);
 }
 function addCue(m){
  const cue={id:uuid(),name:m.name,mediaId:m.id,playbackMediaId:null,layer:0,in:0,out:m.kind==='image'?10:(m.duration||10),mode:'once',auto:false};state.cues.push(cue);mark();selectCue(cue.id).catch(error);
 }
 async function selectCue(id){followingAuto=false;
  const serial=++prepareSerial;selectedId=id;renderQueue();inspector();const c=selected();$('go').disabled=true;$('readyState').textContent='LOADING';$('readyState').className='status';
  if(!c){engine.clearPreview();$('readyState').textContent='EMPTY';return false;}
  $('previewTitle').textContent=c.name;$('pvwEmpty').hidden=true;
  if(c.mode==='pingpong'&&!c.playbackMediaId){engine.clearPreview();$('readyState').textContent='NEEDS CACHE';$('readyState').className='status error';return false;}
  const m=mediaById(c.playbackMediaId||c.mediaId);if(!m){engine.clearPreview();throw new Error('미디어가 없습니다.');}
  try{
   const ready=await engine.prepare(c,m);if(!ready||serial!==prepareSerial)return false;
   $('readyState').textContent='READY';$('readyState').className='status ready';$('go').disabled=locked;renderQueue();status('다음 큐 준비 완료 · GO로 공연 출력에 반영');return true;
  }catch(e){if(serial!==prepareSerial)return false;$('readyState').textContent='ERROR';$('readyState').className='status error';renderQueue();throw e;}
 }
 async function go(){
  if(locked)throw new Error('출력 잠금을 해제하세요.');if(busy)return false;
  if(!engine.prepared?.ready)throw new Error('먼저 다음 큐를 READY 상태로 준비하세요.');busy=true;$('go').disabled=true;
  try{await engine.sync(state,locked);const deck=await engine.go();$('pgmEmpty').hidden=true;$('programTitle').textContent=deck.cue.name;$('programState').textContent='ON AIR';$('programState').className='status ready';
   renderLayers();renderQueue();status(`ON AIR · ${deck.cue.name}`);const index=state.cues.findIndex(c=>c.id===deck.cue.id);const next=state.cues[index+1];if(next)await selectCue(next.id);else{$('readyState').textContent='END OF CUES';$('readyState').className='status';$('previewTitle').textContent='마지막 큐';renderQueue();}return true;
  }finally{busy=false;$('go').disabled=locked||!engine.prepared?.ready;if(pendingAuto)queueMicrotask(pumpAuto);}
 }
 async function loadProject(project){
  if(locked)throw new Error('프로젝트를 바꾸기 전에 출력 잠금을 해제하세요.');++projectSerial;pendingAuto=null;clearTimeout(autosaveTimer);engine.hold();engine.black();engine.clearPreview();state=project;selectedId=null;engine.layers=state.layers;engine.resize(state.output);await engine.sync(state,locked);$('projectName').textContent=state.name;$('pgmEmpty').hidden=false;$('pvwEmpty').hidden=false;$('programTitle').textContent='출력 대기';$('programState').textContent='STANDBY';renderLibrary();document.querySelector('.library').scrollTop=0;renderQueue();renderLayers();inspector();renderSettings();dirty=false;$('dirtyStatus').textContent='프로젝트 불러옴';if(state.cues.length)await selectCue(state.cues[0].id);status('프로젝트를 불러왔습니다. 누락 미디어와 출력 설정을 확인하세요.');
 }
 function renderSettings(){
  $('outWidth').value=state.output.width;$('outHeight').value=state.output.height;$('outFps').value=state.output.fps;$('canvasStatus').textContent=`${state.output.width} × ${state.output.height}`;
  const select=$('displaySelect');select.replaceChildren();environment.displays.forEach((d,i)=>select.add(new Option(`${i+1}. ${d.label} · ${d.bounds.width}×${d.bounds.height}`,String(d.id))));
  const views=$('viewSettings');views.replaceChildren();state.views.forEach((source,i)=>{const row=document.createElement('div');row.className='view-setting';const label=document.createElement('label');label.textContent=`VIEW ${String(i+1).padStart(2,'0')}`;const select=document.createElement('select');sources.forEach(([v,l])=>select.add(new Option(l,v)));select.value=source;select.onchange=()=>{state.views[i]=select.value;mark();};row.append(label,select);views.append(row);});
  $('diagnostics').textContent=JSON.stringify({version:environment.version,render:'독립 재생 엔진 / WebGL · 운영 미리보기 10 FPS',maxTexture:engine.pgm.maxTexture,ffmpeg:environment.ffmpeg,ffprobe:environment.ffprobe,videoDecode:environment.gpu.video_decode,compositing:environment.gpu.gpu_compositing,physicalDisplays:environment.displays.length,cache:environment.cacheDir},null,2);renderOutputList();
 }
 function renderOutputList(){
  const list=$('outputList');list.replaceChildren();for(const [id,item] of outputWindows){if(item.window.closed){outputWindows.delete(id);continue;}const row=document.createElement('div');row.className='output-line';const name=document.createElement('span');name.textContent=sourceLabel(item.source);const close=document.createElement('button');close.className='small';close.textContent='창 닫기';close.onclick=()=>{item.window.close();outputWindows.delete(id);renderOutputList();};row.append(name,close);list.append(row);}
 }
 engine.onOutputClosed=id=>{outputWindows.delete(id);renderOutputList();};
 async function openOutput(source){
  renderOutputList();if(outputWindows.size>=10)throw new Error('독립 출력 창은 최대 10개입니다.');
  const id=uuid();await engine.command('openOutput',{id,source,display:$('displaySelect').value,fullscreen:$('fullScreen').checked});
  const win={closed:false,close(){this.closed=true;engine.fire('closeOutput',{id});}};outputWindows.set(id,{window:win,source});renderOutputList();status(sourceLabel(source)+' 독립 창을 열었습니다.');return {id};
 }
 window.playerDiagnostics.openOutput=openOutput;
 $('importMedia').onclick=action(async()=>addMedia(await window.native.importMedia()));
 $('go').onclick=action(go);
 $('hold').onclick=()=>{pendingAuto=null;++projectSerial;engine.hold();$('programState').textContent='HOLD';status('현재 프레임에서 일시정지했습니다.');};
 $('resume').onclick=()=>{engine.resume();$('programState').textContent='ON AIR';status('재생을 재개했습니다.');};
 $('black').onclick=action(async()=>{if(locked)throw new Error('출력 잠금을 해제하세요.');pendingAuto=null;++projectSerial;engine.black();$('pgmEmpty').hidden=true;$('programTitle').textContent='BLACK';$('programState').textContent='BLACK';renderLayers();renderQueue();status('출력을 BLACK으로 전환했습니다.');});
 $('lock').onclick=()=>{locked=!locked;engine.sync(state,locked);$('lock').textContent='출력 잠금 '+(locked?'켜짐':'꺼짐');$('lock').classList.toggle('locked',locked);$('go').disabled=locked||!engine.prepared?.ready;renderLayers();status(locked?'GO·BLACK·레이어 조작을 잠갔습니다.':'출력 잠금을 해제했습니다.');};
 $('openProject').onclick=action(async()=>{if(locked)throw new Error('출력 잠금을 해제하세요.');const result=await window.native.open();if(result)await loadProject(result.project);});
 $('saveProject').onclick=action(async()=>{const result=await window.native.save(state);if(result){dirty=false;clearTimeout(autosaveTimer);$('projectName').textContent=result.split(/[\\/]/).at(-1);$('dirtyStatus').textContent='저장 완료';status('프로젝트 저장: '+result);}});
 $('demoProject').onclick=action(async()=>{if(locked)throw new Error('출력 잠금을 해제하세요.');await loadProject(await window.native.demo());status('데모 준비 완료 · GO를 차례로 눌러 레이어와 알파 합성을 확인하세요.');});
 $('packageProject').onclick=action(async()=>{status('미디어와 루프 캐시를 패키지로 복사 중…');$('packageProject').disabled=true;try{const file=await window.native.packageProject(state);status(file?'공연 패키지 저장 완료: '+file:'패키지 저장을 취소했습니다.');}finally{$('packageProject').disabled=false;}});
 $('restore').onclick=action(async()=>{if(locked)throw new Error('프로젝트를 바꾸기 전에 출력 잠금을 해제하세요.');const recovery=await window.native.recovery();if(recovery)await loadProject(recovery);else status('복구할 자동 저장본이 없습니다.');});
 $('showOutputs').onclick=action(async()=>{environment=await window.native.environment();renderSettings();$('settings').showModal();});$('closeSettings').onclick=()=>$('settings').close();
 $('applyCanvas').onclick=action(async()=>{if(locked)throw new Error('출력 잠금을 해제하세요.');const width=Math.round(Number($('outWidth').value)),height=Math.round(Number($('outHeight').value));if(!Number.isFinite(width)||!Number.isFinite(height)||width<64||width>7680||height<64||height>4320)throw new Error('가로 64–7680, 세로 64–4320 범위를 입력하세요.');const output={width,height,fps:Number($('outFps').value)};engine.resize(output);state.output=output;renderSettings();mark();if(selected())await selectCue(selectedId);status('합성 캔버스를 변경했습니다.');});
 $('openOutput').onclick=action(()=>openOutput($('outputSource').value));$('openMultiview').onclick=action(()=>openOutput('multiview'));
 $('duplicateCue').onclick=action(async()=>{const c=selected();if(!c)return;const index=state.cues.indexOf(c),copy={...c,id:uuid(),name:c.name+' · 복사'};state.cues.splice(index+1,0,copy);mark();await selectCue(copy.id);});
 $('deleteCue').onclick=action(async()=>{const index=state.cues.findIndex(c=>c.id===selectedId);if(index<0)return;state.cues.splice(index,1);mark();await selectCue(state.cues[Math.min(index,state.cues.length-1)]?.id||null);});
 for(const [id,delta] of [['moveUp',-1],['moveDown',1]])$(id).onclick=()=>{const index=state.cues.findIndex(c=>c.id===selectedId);if(index<0||index+delta<0||index+delta>=state.cues.length)return;[state.cues[index],state.cues[index+delta]]=[state.cues[index+delta],state.cues[index]];renderQueue();mark();};
 const edit=async()=>{
  const c=selected();if(!c)return;const m=mediaById(c.mediaId),start=Number($('cueIn').value),end=Number($('cueOut').value);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||m.kind!=='image'&&end>m.duration+.02){inspector();throw new Error('IN은 0 이상, OUT은 IN 이후이며 영상 길이 이내여야 합니다.');}
  const changed=c.in!==start||c.out!==end||c.mode!==$('cueMode').value;
  Object.assign(c,{name:$('cueName').value.trim()||m.name,layer:Number($('cueLayer').value),in:start,out:end,mode:$('cueMode').value,auto:$('cueAuto').checked});if(changed)c.playbackMediaId=null;mark();await selectCue(c.id);
 };
 for(const id of ['cueName','cueLayer','cueIn','cueOut','cueMode','cueAuto'])$(id).onchange=action(edit);
 $('prepareLoop').onclick=action(async()=>{
  const c=selected();if(!c||c.mode!=='pingpong')return;$('job').querySelector('h2').textContent='핑퐁 루프 준비 중';$('job').querySelector('p').textContent='선택한 구간의 정방향·역방향 영상을 로컬에서 만듭니다. 캐시는 영상 전용이며 오디오는 제거됩니다.';$('job').showModal();$('jobProgress').textContent='캐시 준비 중…';
  try{const result=await window.native.pingpong(c.mediaId,c);state.media.push(result);c.playbackMediaId=result.id;mark();renderLibrary();await selectCue(c.id);status('핑퐁 캐시 준비 완료 · 영상 전용, 오디오는 제거됨');}finally{$('job').close();inspector();}
 });
 $('cancelJob').onclick=()=>window.native.cancelJob();$('job').addEventListener('cancel',e=>{e.preventDefault();window.native.cancelJob();});window.native.onJob(data=>{$('jobProgress').textContent=data.text;});
 document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.key.toLowerCase()==='s'&&!$('settings').open&&!$('job').open){e.preventDefault();document.activeElement?.blur();$('saveProject').click();return;}
  if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||$('settings').open||$('job').open)return;
  if(e.code==='Space'&&!e.repeat){e.preventDefault();action(go)();}
 });
 document.addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('drop-active');});document.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('drop-active');});document.addEventListener('drop',action(async e=>{e.preventDefault();document.body.classList.remove('drop-active');const paths=window.native.droppedFiles([...e.dataTransfer.files]);if(paths.length)await addMedia(await window.native.importPaths(paths));}));
 setInterval(()=>{
  $('fps').textContent=Math.round(engine.fps)+' FPS';$('renderInfo').textContent=engine.pgm.lastError?'GPU 오류':`출력 ${Math.round(engine.fps)} FPS · 미리보기 10 FPS`;
  const active=engine.active.filter(Boolean);$('programTime').textContent=fmt(active.at(-1)?.time);$('previewTime').textContent=fmt(engine.prepared?.time);
  for(let i=0;i<4;i++)if($('layerName'+i))$('layerName'+i).textContent=engine.active[i]?.cue.name||'비어 있음';
  if(active.length&&active.every(d=>d.ended))$('programState').textContent='END / HOLD';
  renderOutputList();
 },500);
 $('toolsStatus').textContent=environment.ffmpeg?'FFmpeg 연결됨':'FFmpeg 없음 · 기본 재생 가능';
 renderLibrary();renderQueue();renderLayers();renderSettings();inspector();
 status('준비 완료 · 기본 오디오는 음소거입니다. 레이어에서 개별 해제할 수 있습니다.');
}

