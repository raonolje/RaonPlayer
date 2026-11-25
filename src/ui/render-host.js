import {PlaybackEngine} from './engine.js';
import {loopMemory} from './loop-cache.js';
const engine=new PlaybackEngine(document.getElementById('pgm'),document.getElementById('pvw'),[],{width:1920,height:1080,fps:60});
window.playbackEngine=engine;
let manifest={cues:[],media:[],views:[]},locked=false,sequence=0,preparing=null,autoSerial=0,prepareSerial=0;
const outputPool=[];let poolReady;
const failedOutputs=new Map(),outputs=new Map(),ids=new WeakMap();let nextId=0;
function deck(d){if(!d)return null;if(!ids.has(d))ids.set(d,++nextId);return {uid:ids.get(d),cue:d.cue,media:d.media,ready:d.ready,playing:d.playing,ended:d.ended,time:d.time,frameIndex:d.frameIndex,absoluteFrame:d.absoluteFrame,behindFrames:d.behindFrames,cache:d.cache?{frames:d.cache.frames,fps:d.cache.fps,duration:d.cache.duration}:null};}
function snapshot(){return {sequence:++sequence,active:engine.active.map(deck),prepared:deck(engine.prepared),fps:engine.fps,running:engine.running,generation:engine.generation||0,maxTexture:engine.pgm.maxTexture,memory:{...loopMemory(),gpu:engine.pgm.gpuMemory()},output:engine.output};}
const emit=(event,data)=>window.native.engineEvent({event,data});
engine.onError=e=>emit('error',e.message);
function assertOutputs(){if(failedOutputs.size)throw new Error('오류가 난 출력 창을 닫고 다시 연 뒤 재개하세요.');}
async function prepare(cue,media){engine.assertGPU();
 const key=JSON.stringify([cue,media]);
 if(preparing?.key===key)return preparing.promise;
 const serial=++prepareSerial;
 if(preparing){await preparing.promise.catch(()=>{});if(serial!==prepareSerial)return false;}
 if(engine.prepared&&JSON.stringify([engine.prepared.cue,engine.prepared.media])===key)return true;
 const record={key,promise:engine.prepare(cue,media)};preparing=record;
 try{return await record.promise;}finally{if(preparing===record)preparing=null;}
}
async function go(){assertOutputs();const d=await engine.go(),generation=engine.generation||0;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('출력 프레임 대기 시간이 초과되었습니다.')),3000);(engine.presentationWaiters??=[]).push(()=>{clearTimeout(timer);resolve();});});
 if(generation!==(engine.generation||0)||!engine.active.includes(d))throw Object.assign(new Error('정지 또는 프로젝트 변경으로 큐 전환을 취소했습니다.'),{code:'PLAYBACK_CANCELLED'});return d;
}
engine.onEnd=async d=>{
 if(!d.cue.auto||locked)return;
 const serial=autoSerial,generation=engine.generation||0;
 const index=manifest.cues.findIndex(c=>c.id===d.cue.id),cue=index>=0?manifest.cues[index+1]:null;
 if(!cue)return;
 const media=manifest.media.find(m=>m.id===(cue.playbackMediaId||cue.mediaId));
 try{
  if(!await prepare(cue,media))return;
  if(serial!==autoSerial||generation!==(engine.generation||0)||locked||!engine.active.includes(d))return;
  // Recheck the queue after async preparation: deleting/reordering a live cue
  // must not execute an obsolete automatic transition.
  const now=manifest.cues.findIndex(c=>c.id===d.cue.id);
  if(now<0||manifest.cues[now+1]?.id!==cue.id)return;
  await go();emit('auto',{cue,snapshot:snapshot()});
  const next=manifest.cues[now+2],m=next&&manifest.media.find(m=>m.id===(next.playbackMediaId||next.mediaId));
  if(next&&m&&!(next.mode==='pingpong'&&!next.playbackMediaId))void prepare(next,m).catch(e=>emit('error',e.message));
 }catch(e){if(e.code==='PLAYBACK_CANCELLED'||serial!==autoSerial||generation!==(engine.generation||0)||locked)return;emit('error',e.message);}
};
const subscribers=new Map();engine.afterPresent=()=>{for(const [win,render] of subscribers){if(win.closed)subscribers.delete(win);else try{render();}catch{}}};
// One immutable GPU snapshot per composite revision. Output workers receive
// reference-counted clones instead of independent async bitmap copy requests.
const outputSnapshots=new Map();
async function captureOutput(key){
 if(key==='pgm'||key==='pvw'){
  const compositor=engine[key];let entry=outputSnapshots.get(key);
  if(entry?.revision!==compositor.revision){
   const frame=new VideoFrame(compositor.canvas,{timestamp:Math.round(performance.now()*1000)});
   entry?.frame.close();entry={revision:compositor.revision,frame};outputSnapshots.set(key,entry);
  }
  return entry.frame.clone();
 }
 if(/^layer[0-3]$/.test(key)){const d=engine.active[Number(key.at(-1))];if(!d)return null;if(d.cache)return d.frame.clone();return createImageBitmap(d.element);}
 return null;
}
window.playerShared={capture:captureOutput,outputError:(id,message)=>{failedOutputs.set(id,message);engine.hold();engine.onError(new Error(message));},subscribe:(win,render)=>{subscribers.set(win,render);return ()=>subscribers.delete(win);},frames:()=>engine.active.map(d=>d?.cache?{uid:deck(d).uid,frame:d.absoluteFrame}:null),signature:key=>key==='pgm'?engine.pgm.revision:key==='pvw'?engine.pvw.revision:(()=>{const d=engine.active[Number(key.at(-1))];return d?[deck(d).uid,d.renderKey]:null;})(),source:key=>engine.source(key),views:()=>manifest.views,sourceLabel:key=>({pgm:'PGM',pvw:'PVW',layer0:'레이어 01',layer1:'레이어 02',layer2:'레이어 03',layer3:'레이어 04'}[key]||key),outputFullscreen:(id,full)=>window.native.outputFullscreen(id,full),info:()=>({output:engine.output,fps:engine.fps})};
const methods={
 init:async({layers,output})=>{engine.layers=layers;engine.resize(output);await poolReady;},
 sync:({state,lock})=>{manifest=state;locked=lock;engine.layers=state.layers;engine.active.forEach((d,i)=>d?.setMuted(state.layers[i].mute));},
 prepare:({cue,media})=>prepare(cue,media),
 go:async()=>deck(await go()),
 hold:()=>{++autoSerial;engine.hold();},resume:()=>{assertOutputs();engine.resume();},
 black:()=>{++autoSerial;engine.black();for(const w of outputs.values())if(!w.closed)w.forceBlack?.();},clearPreview:()=>{++prepareSerial;engine.clearPreview();},
 resize:({output})=>engine.resize(output),
 mute:({uid,muted})=>engine.active.find(d=>ids.get(d)===uid)?.setMuted(muted),
 dispose:({uid})=>{const i=engine.active.findIndex(d=>ids.get(d)===uid);if(i>=0){engine.active[i].dispose();engine.active[i]=null;}},
 stats:()=>snapshot(),
 pixel:({x,y})=>{const p=new Uint8Array(4),gl=engine.pgm.gl;gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p);},
 openOutput:async({id,source,display,fullscreen})=>{engine.assertGPU();
  await poolReady;const entry=outputPool.find(p=>!p.id);if(!entry)throw new Error('독립 출력 창은 최대 10개입니다.');
  entry.id=id;outputs.set(id,entry.w);entry.w.configureOutput({id,source});
  try{await window.native.configureOutput(entry.pool,display,fullscreen,true);}catch(e){entry.w.disableOutput();entry.id=null;outputs.delete(id);throw e;}return true;
 },
 closeOutput:async({id})=>{failedOutputs.delete(id);const p=outputPool.find(p=>p.id===id);if(p){p.w.disableOutput();p.id=null;outputs.delete(id);await window.native.configureOutput(p.pool,null,false,false);emit('outputClosed',id);}},

};
window.native.onEngineCommand(async({id,method,payload})=>{try{if(!Object.hasOwn(methods,method))throw new Error('지원하지 않는 재생 명령');const value=await methods[method](payload||{});window.native.engineReply({id,value,snapshot:snapshot()});}catch(e){window.native.engineReply({id,error:e.message,snapshot:snapshot()});}});
window.native.onOutputClosed(id=>{failedOutputs.delete(id);const p=outputPool.find(p=>p.id===id);if(p){p.w.disableOutput();p.id=null;outputs.delete(id);emit('outputClosed',id);}});
setInterval(()=>{emit('snapshot',snapshot());for(const [id,w] of outputs)if(w.closed){failedOutputs.delete(id);outputs.delete(id);emit('outputClosed',id);}},100);
engine.render(performance.now());
poolReady=(async()=>{for(let i=0;i<10;i++){
 const pool='slot-'+i,u=new URL('player://engine/output.html');u.searchParams.set('output','1');u.searchParams.set('pool',pool);u.searchParams.set('id','idle-'+pool);
 const w=window.open(u.href,'pool-'+pool,'width=960,height=540');if(!w)throw new Error('출력 창을 미리 준비하지 못했습니다.');
 for(let n=0;!w.configureOutput;n++){if(n>1000)throw new Error('출력 창 준비 시간이 초과되었습니다.');await new Promise(r=>setTimeout(r,10));}
 await w.outputReady;outputPool.push({pool,w,id:null});
}})();poolReady.catch(e=>emit('error',e.message));window.native.engineReady();

// At most one thumbnail batch may be capturing, encoding, or waiting for the
// operator. Unchanged sources need no JPEG, and encoding runs off this clock.
let previewWorker,previewBusy=false,previewCredit=true;
const previewKeys=new Map();
const previewStats=window.previewDiagnostics={captured:0,sent:0,errors:0,waiting:0};
window.native.onPreviewCredit(()=>{previewCredit=true;previewStats.waiting=0;});
function startPreviewWorker(){
 const worker=new Worker(new URL('./preview-worker.js',import.meta.url));
 worker.onmessage=({data})=>{previewBusy=false;if(data.error){previewStats.errors++;previewKeys.clear();return;}previewCredit=false;previewStats.waiting=1;previewStats.sent++;window.native.enginePreview(data.images);};
 worker.onerror=()=>{previewStats.errors++;previewBusy=false;worker.terminate();previewWorker=startPreviewWorker();previewKeys.clear();};return worker;
}
previewWorker=startPreviewWorker();
setInterval(async()=>{
 if(previewBusy||!previewCredit)return;
 const keys=['pgm','pvw'].filter(k=>previewKeys.get(k)!==engine[k].revision);
 if(!keys.length)return;previewBusy=true;const bitmaps={},revisions=new Map();
 try{
  for(const k of keys){const source=engine.source(k);revisions.set(k,engine[k].revision);bitmaps[k]=await createImageBitmap(source,{resizeWidth:480,resizeHeight:Math.max(32,Math.round(480*source.height/source.width)),resizeQuality:'low'});}
  previewWorker.postMessage(bitmaps,Object.values(bitmaps));for(const [k,v] of revisions)previewKeys.set(k,v);previewStats.captured++;
 }catch{for(const bitmap of Object.values(bitmaps))bitmap.close();previewBusy=false;previewStats.errors++;}
},100);
