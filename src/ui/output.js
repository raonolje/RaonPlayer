const $=id=>document.getElementById(id);
function startOutput(){
 document.body.classList.add('output-mode');const canvas=$('outputCanvas');canvas.width=64;canvas.height=64;const safetyBlack=document.createElement('div');safetyBlack.id='safetyBlack';$('outputRoot').append(safetyBlack);
 const grid=document.createElement('div');grid.id='multiviewRoot';grid.hidden=true;const cells=Array.from({length:10},()=>{const cell=document.createElement('section'),title=document.createElement('span'),image=document.createElement('div');cell.className='view-cell';image.className='view-image';cell.append(title,image);grid.append(cell);return {cell,title,image};});$('outputRoot').append(grid);
 let readyResolve,readyReject;window.outputReady=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});window.outputReady.catch(()=>{});const queries=new Map();let nextQuery=0;const worker=new Worker(new URL('./output-worker.js',import.meta.url),{type:'module'}),canvases=[canvas].map(c=>c.transferControlToOffscreen());worker.postMessage({kind:'init',canvases},canvases);let layoutKey,layoutSize,rects;
 let source=new URLSearchParams(location.search).get('source')||'pgm',enabled=!new URLSearchParams(location.search).has('pool'),id=new URLSearchParams(location.search).get('id'),generation=0,pending=0,previousSignature,chain=Promise.resolve(),failed=false,previousAck=0;
 const reset=()=>window.outputDiagnostics={updates:0,skips:[0,0,0,0],previous:[null,null,null,null],queued:pending,maxQueued:pending,maxAckGap:0,maxLatencyMs:0,maxDrawMs:0,slowJobs:[],failures:0};reset();window.resetOutputAudit=()=>{previousAck=0;reset();};
 const fail=message=>{if(failed)return;failed=true;window.outputDiagnostics.failures++;$('outputHint').textContent=message;window.opener?.playerShared?.outputError(id,'출력 창 오류: '+message);};
 worker.onerror=e=>{const message=e.message||'출력 작업이 중단되었습니다.';readyReject(new Error(message));fail(message);};window.checkOutputGPU=()=>new Promise((resolve,reject)=>{const request=++nextQuery,timer=setTimeout(()=>{queries.delete(request);reject(new Error('출력 GPU 상태 응답 시간 초과'));},5000);queries.set(request,value=>{clearTimeout(timer);resolve(value);});worker.postMessage({kind:'gpu-status',request});});
 worker.onmessage=({data:d})=>{if(d.kind==='ready'){readyResolve();return;}if(d.kind==='gpu-status'){queries.get(d.request)?.(d.error);queries.delete(d.request);return;}
  if(d.generation!==generation)return;pending--;const a=window.outputDiagnostics;a.queued=pending;
  if(d.error){fail(d.error);return;}const now=performance.now();if(previousAck)a.maxAckGap=Math.max(a.maxAckGap||0,now-previousAck);previousAck=now;a.maxLatencyMs=Math.max(a.maxLatencyMs||0,now-d.enqueuedAt);a.maxDrawMs=Math.max(a.maxDrawMs||0,d.drawMs);if(now-d.enqueuedAt>50&&a.slowJobs.length<30)a.slowJobs.push({gpuMetrics:d.gpuMetrics,latency:now-d.enqueuedAt,capture:d.capturedAt-d.enqueuedAt,dispatch:d.sentWall-performance.timeOrigin-d.capturedAt,workerWait:d.workerStartWall-d.sentWall,draw:d.drawMs,ack:performance.timeOrigin+now-d.workerEndWall,frames:d.frames,visibility:document.visibilityState});
  if(!safetyBlack.hidden&&!failed){const epoch=generation;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(epoch===generation&&!failed)safetyBlack.hidden=true;}));}a.width=d.width;a.height=d.height;a.updates++;d.frames.forEach((frame,i)=>{if(d.source==='pvw'||d.source.startsWith('layer')&&Number(d.source.at(-1))!==i)return;const prior=a.previous[i];if(frame&&prior?.uid===frame.uid)a.skips[i]+=Math.max(0,frame.frame-prior.frame-1);a.previous[i]=frame;});
 };
 const close=images=>{for(const image of Object.values(images))image?.close();};
 const render=()=>{
  if(!enabled||failed)return;const shared=window.opener?.playerShared;if(!shared)return;
  const width=Math.max(64,innerWidth),height=Math.max(64,innerHeight),pixelRatio=devicePixelRatio||1,views=shared.views(),signature=JSON.stringify([width,height,pixelRatio,source==='multiview'?views.map(k=>[k,shared.signature(k)]):[source,shared.signature(source)]]);
  if(signature===previousSignature)return;if(source==='multiview'&&layoutKey!==JSON.stringify(views)){layoutKey=JSON.stringify(views);cells.forEach((c,i)=>{c.title.textContent=String(i+1).padStart(2,'0')+'  '+shared.sourceLabel(views[i]);c.cell.dataset.source=views[i];});}if(source==='multiview'&&layoutSize!==width+','+height+','+layoutKey){layoutSize=width+','+height+','+layoutKey;rects=cells.map(c=>{const r=c.image.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});}
  if(pending>=8){fail('출력 프레임 대기열이 8개를 초과했습니다.');return;}
  previousSignature=signature;pending++;const a=window.outputDiagnostics;a.queued=pending;a.maxQueued=Math.max(a.maxQueued||0,pending);
  const epoch=generation,enqueuedAt=performance.now(),jobSource=source,frames=shared.frames(),keys=[...new Set(source==='multiview'?views:[source])],labels=Object.fromEntries(keys.map(k=>[k,shared.sourceLabel(k)]));
  const sourceKeys=Object.fromEntries(keys.map(key=>[key,JSON.stringify(shared.signature(key))]));const jobRects=rects;const captures=Promise.allSettled(keys.map(async key=>[key,await shared.capture(key)])).then(results=>({results,capturedAt:performance.now()}));
  chain=chain.then(async()=>{
   const {results,capturedAt}=await captures,images=Object.fromEntries(results.filter(r=>r.status==='fulfilled').map(r=>r.value));
   if(epoch!==generation){close(images);return;}
   const error=results.find(r=>r.status==='rejected');if(error){close(images);pending--;fail(error.reason?.message||'출력 프레임을 준비하지 못했습니다.');return;}
   try{worker.postMessage({kind:'render',generation:epoch,source:jobSource,views,labels,frames,images,width,height,pixelRatio,rects:jobRects,sourceKeys,enqueuedAt,capturedAt,sentWall:performance.timeOrigin+performance.now()},Object.values(images).filter(Boolean));}catch(e){close(images);throw e;}
  }).catch(e=>{if(epoch===generation){pending--;fail(e.message);}});
 };
 const shared=window.opener?.playerShared,unsubscribe=shared?.subscribe?.(window,render);addEventListener('unload',()=>{unsubscribe?.();worker.terminate();},{once:true});
 window.forceBlack=()=>{safetyBlack.hidden=false;generation++;pending=0;window.outputDiagnostics.queued=0;chain=Promise.resolve();previousSignature=null;previousAck=0;worker.postMessage({kind:'configure',generation});};
 window.configureOutput=config=>{safetyBlack.hidden=false;source=config.source;id=config.id;grid.hidden=source!=='multiview';layoutKey=null;layoutSize=null;generation++;pending=0;chain=Promise.resolve();failed=false;enabled=true;previousSignature=null;previousAck=0;reset();worker.postMessage({kind:'configure',generation});const url=new URL(location.href);url.searchParams.set('id',id);url.searchParams.set('source',source);history.replaceState(null,'',url.href);render();};
 window.disableOutput=()=>{enabled=false;generation++;pending=0;chain=Promise.resolve();worker.postMessage({kind:'disable',generation});};
 render();if(new URLSearchParams(location.search).get('embed')==='1')$('outputHint').hidden=true;
 document.addEventListener('dblclick',()=>window.opener?.playerShared?.outputFullscreen(id,null));document.addEventListener('keydown',e=>{if(e.key==='Escape'){window.opener?.playerShared?.outputFullscreen(id,false);if(document.fullscreenElement)document.exitFullscreen();}});
}
startOutput();
