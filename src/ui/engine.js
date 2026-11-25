import {acquireLoop,loopAudio} from './loop-cache.js';
const waitEvent=(element,event,timeout=20000)=>new Promise((resolve,reject)=>{
 const onEvent=()=>{cleanup();resolve();},onError=()=>{cleanup();reject(new Error('재생할 수 없는 미디어입니다. MP4(H.264) 또는 WebM(VP9)으로 변환해 주세요.'));};
 const timer=setTimeout(()=>{cleanup();reject(new Error('미디어 준비 시간을 초과했습니다.'));},timeout);
 const cleanup=()=>{clearTimeout(timer);element.removeEventListener(event,onEvent);element.removeEventListener('error',onError);};
 element.addEventListener(event,onEvent,{once:true});element.addEventListener('error',onError,{once:true});
});
export class Deck {
 constructor(media,cue,outputFps=60){this.media=media;this.cue={...cue};this.outputFps=outputFps;this.playSerial=0;this.element=null;this.ready=false;this.disposed=false;this.playing=false;this.ended=false;this.imageTime=0;this.started=0;this.in=cue.playbackMediaId?0:cue.in;this.out=cue.playbackMediaId?media.duration:cue.out;}
 async load(){
  if(this.media.missing||!this.media.url)throw new Error('미디어 파일이 누락되었습니다. 다시 연결해 주세요.');
  if(this.media.kind==='video'&&this.cue.mode!=='once'){
   const lease=await acquireLoop(this.media,this.cue,this.outputFps);
   if(this.disposed){lease.release();throw new Error('준비가 취소되었습니다.');}
   this.lease=lease;this.cache=lease.cache;this.in=this.cache.start;this.out=this.in+this.cache.duration;
   this.element=document.createElement('video');this.element.muted=true;
   this.offset=0;this.ready=true;this.updateFrame(0);return this;
  }
  if(this.media.kind==='image'){
   const image=new Image();image.crossOrigin='anonymous';const waiting=waitEvent(image,'load');image.src=this.media.url;this.element=image;await waiting;this.imageTime=this.in;
  }else{
   const v=document.createElement('video');v.crossOrigin='anonymous';v.preload='auto';v.playsInline=true;v.muted=true;v.disablePictureInPicture=true;this.element=v;
   const metadata=waitEvent(v,'loadedmetadata');v.src=this.media.url;v.load();await metadata;
   this.out=this.out>this.in?Math.min(this.out,v.duration):v.duration;
   if(this.in>=v.duration||this.out<=this.in)throw new Error('IN / OUT 구간이 영상 길이를 벗어났습니다.');
   if(this.in>0){const seek=waitEvent(v,'seeked');v.currentTime=this.in;await seek;}
   if(v.readyState<2)await waitEvent(v,'loadeddata');
  }
  if(this.disposed)throw new Error('준비가 취소되었습니다.');this.ready=true;return this;
 }
 // AudioContext.currentTime advances in device-sized blocks on some Windows
 // outputs. Use the monotonic render clock for video instead of quantizing
 // a 60fps picture to those blocks.
 get elapsed(){return this.offset+(this.playing?Math.max(0,(performance.now()-this.visualEpoch)/1000):0);}
 get time(){return this.cache?this.in+(this.elapsed%this.cache.duration):this.media.kind==='image'?this.imageTime:this.element?.currentTime||0;}
 get width(){return this.cache?.width||this.element?.videoWidth||this.element?.naturalWidth||1;}
 get height(){return this.cache?.height||this.element?.videoHeight||this.element?.naturalHeight||1;}
 get renderSource(){return this.frame||this.element;}
 get renderKey(){return this.cache?this.frameIndex:this.media.kind==='image'?'image':this.element.currentTime;}
 setMuted(muted){if(this.element)this.element.muted=muted;if(this.gain)this.gain.gain.value=muted?0:1;this.muted=muted;}
 updateFrame(absolute){
  const index=absolute%this.cache.frames;
  if(index!==this.frameIndex){this.frame=this.cache.framesData[index];this.frameIndex=index;}
  this.absoluteFrame=absolute;this.cycle=Math.floor(absolute/this.cache.frames);
 }
 viewSource(){
  if(!this.cache)return this.element;
  if(!this.view){this.view=new OffscreenCanvas(this.width,this.height);this.viewContext=this.view.getContext('2d');}
  if(this.viewIndex!==this.frameIndex){this.viewContext.clearRect(0,0,this.width,this.height);this.viewContext.drawImage(this.frame,0,0);this.viewIndex=this.frameIndex;}return this.view;
 }
 async play(muted=true){
  if(!this.ready||this.disposed)return;
  const serial=++this.playSerial;
  if(this.cache){
   if(this.playing){this.setMuted(muted);return;}
   const context=loopAudio();await context.resume();if(this.disposed||serial!==this.playSerial)return;
   this.audioEpoch=context.currentTime;this.visualEpoch=performance.now();this.playing=true;this.ended=false;this.setMuted(muted);
   if(this.cache.audio){const source=context.createBufferSource(),gain=context.createGain();source.buffer=this.cache.audio;source.loop=true;source.loopEnd=this.cache.duration;gain.gain.value=muted?0:1;source.connect(gain).connect(context.destination);source.start(this.audioEpoch,this.offset%this.cache.duration);this.audioSource=source;this.gain=gain;}
   return;
  }
  this.playing=true;this.ended=false;this.started=performance.now()-this.imageTime*1000;if(this.media.kind!=='image'){this.setMuted(muted);await this.element.play();}
 }
 pause(){++this.playSerial;if(this.cache&&this.playing)this.offset=this.elapsed;this.playing=false;this.audioSource?.stop();this.audioSource?.disconnect();this.gain?.disconnect();this.audioSource=null;this.gain=null;if(this.media.kind!=='image')this.element?.pause();}
 tick(now){
  if(!this.ready||!this.playing)return false;
  if(this.cache){
   const target=Math.floor(this.elapsed*this.cache.fps+1e-7);
   // Preserve frame order through the wrap even if a timer is a little late.
   // The render scheduler catches up with short ticks rather than dropping a
   // cached end/start frame. Sustained overload is reported, not hidden.
   const frame=Math.min(target,this.absoluteFrame+1);this.behindFrames=target-frame;
   if(this.behindFrames/this.cache.fps>.25){
    this.overloadSince??=performance.now();
    if(performance.now()-this.overloadSince>=1000){this.offset=this.absoluteFrame/this.cache.fps;this.visualEpoch=performance.now();this.behindFrames=0;this.overloadSince=null;throw new Error('반복 출력의 250ms 이상 지연이 1초간 지속되었습니다. 출력 해상도나 레이어 부하를 줄이세요.');}
   }else this.overloadSince=null;
   this.updateFrame(frame);return false;
  }
  if(this.media.kind==='image')this.imageTime=(now-this.started)/1000;
  const t=this.time;
  if(t>=this.out-0.012||this.element?.ended){
   if(this.cue.mode!=='once'){
    if(this.media.kind==='image'){this.imageTime=this.in;this.started=now-this.in*1000;}
    else throw new Error('반복 프레임이 준비되지 않았습니다. 큐를 다시 준비하세요.');return false;
   }
   this.pause();this.ended=true;return true;
  }return false;
 }
 dispose(){this.disposed=true;this.pause();this.onDispose?.();this.onDispose=null;this.frame=null;this.lease?.release();this.lease=null;this.cache=null;this.view=null;this.viewContext=null;if(this.element instanceof HTMLVideoElement){this.element.removeAttribute('src');this.element.load();}this.element=null;}
}
export class Compositor {
 gpuMemory(){return {reserved:this.gpuReserved||0,budget:2*1024**3,entries:this.loopTextures?.size||0};}
 async prime(deck,yieldFrame,cancelled){
  if(!deck.cache)return;
  this.loopTextures??=new Map();let entry=this.loopTextures.get(deck.cache);
  if(!entry){
   const bytes=deck.width*deck.height*4*deck.cache.frames;
   if((this.gpuReserved||0)+bytes>this.gpuMemory().budget)throw new Error('고속 반복 GPU 캐시 합계가 2 GiB를 초과합니다. 구간을 줄이거나 30fps로 준비하세요.');
   entry={bytes,owners:new Set(),textures:[],ready:false};this.loopTextures.set(deck.cache,entry);this.gpuReserved=(this.gpuReserved||0)+bytes;
  }
  const cache=deck.cache;entry.owners.add(deck);
  deck.onDispose=()=>{entry.owners.delete(deck);if(!entry.owners.size){for(const t of entry.textures)this.gl.deleteTexture(t);this.loopTextures.delete(cache);this.gpuReserved-=entry.bytes;}};
  if(!entry.promise)entry.promise=(async()=>{
   const gl=this.gl;
   for(const frame of cache.framesData){
    if(cancelled()||this.lost)throw new Error('고속 반복 준비가 취소되었습니다.');
    const tex=gl.createTexture();entry.textures.push(tex);gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame);
    // Spread upload work across presentation ticks; never upload a complete
    // 1080p60 loop in one task while another layer is on air.
    await yieldFrame();
   }
   // A fixed number of presentation ticks does not establish GPU completion.
   // Poll a submitted fence with a zero timeout; keep presenting while the
   // upload batch is pending, then validate without waiting for that batch.
   if(this.webgl2){
    const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    if(!fence)throw new Error('고속 반복 GPU 완료 확인을 시작하지 못했습니다.');
    gl.flush();const deadline=performance.now()+30000;
    try{for(;;){
     if(cancelled()||this.lost)throw new Error('고속 반복 준비가 취소되었습니다.');
     const state=gl.clientWaitSync(fence,0,0);
     if(state===gl.ALREADY_SIGNALED||state===gl.CONDITION_SATISFIED)break;
     if(state===gl.WAIT_FAILED)throw new Error('고속 반복 GPU 완료 확인에 실패했습니다.');
     if(performance.now()>deadline)throw new Error('고속 반복 GPU 준비 시간이 초과되었습니다.');
     await yieldFrame();
    }}finally{gl.deleteSync(fence);}
   }else{await yieldFrame();await yieldFrame();}
   if(cancelled()||this.lost)throw new Error('고속 반복 준비가 취소되었습니다.');
   if(gl.getError()!==gl.NO_ERROR)throw new Error('고속 반복 GPU 프레임을 준비하지 못했습니다. GPU 메모리나 구간 크기를 확인하세요.');
   entry.ready=true;
  })();
  await entry.promise;
 }
 constructor(canvas){
  this.metrics={allocations:0,updates:0,maxUploadMs:0,maxDrawMs:0,slowCalls:[]};this.canvas=canvas;const options={alpha:false,premultipliedAlpha:false,preserveDrawingBuffer:true,antialias:false,powerPreference:'high-performance'},gl=canvas.getContext('webgl2',options)||canvas.getContext('webgl',options);this.webgl2=!!gl?.fenceSync;
  if(!gl)throw new Error('WebGL GPU 합성을 시작할 수 없습니다. GPU 드라이버를 확인해 주세요.');this.gl=gl;this.textures=new Map();
  const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,this.webgl2?'#version 300 es\nin vec2 p;in vec2 uv;out vec2 v;uniform vec4 rect;void main(){gl_Position=vec4(p*rect.zw+rect.xy,0.,1.);v=uv;}':'attribute vec2 p;attribute vec2 uv;varying vec2 v;uniform vec4 rect;void main(){gl_Position=vec4(p*rect.zw+rect.xy,0.,1.);v=uv;}'));
  gl.attachShader(program,compile(gl.FRAGMENT_SHADER,this.webgl2?'#version 300 es\nprecision mediump float;in vec2 v;uniform sampler2D tex;uniform float opacity;uniform float planar;uniform float hasAlpha;uniform sampler2D planeU;uniform sampler2D planeV;uniform sampler2D planeA;out vec4 frag;void main(){vec4 c=texture(tex,v);if(planar>0.5){float y=(c.r-16./255.)*255./219.;float u=(texture(planeU,v).r-128./255.)*255./224.;float w=(texture(planeV,v).r-128./255.)*255./224.;c=vec4(y+1.5748*w,y-0.187324*u-0.468124*w,y+1.8556*u,hasAlpha>0.5?texture(planeA,v).r:1.);}frag=vec4(c.rgb,c.a*opacity);}':'precision mediump float;varying vec2 v;uniform sampler2D tex;uniform float opacity;uniform float planar;uniform float hasAlpha;uniform sampler2D planeU;uniform sampler2D planeV;uniform sampler2D planeA;void main(){vec4 c=texture2D(tex,v);if(planar>0.5){float y=(c.r-16./255.)*255./219.;float u=(texture2D(planeU,v).r-128./255.)*255./224.;float w=(texture2D(planeV,v).r-128./255.)*255./224.;c=vec4(y+1.5748*w,y-0.187324*u-0.468124*w,y+1.8556*u,hasAlpha>0.5?texture2D(planeA,v).r:1.);}gl_FragColor=vec4(c.rgb,c.a*opacity);}'));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);this.program=program;
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0,1,-1,1,0,-1,1,0,1,-1,1,0,1,1,-1,1,0,1,1,1,1]),gl.STATIC_DRAW);
  const pos=gl.getAttribLocation(program,'p'),uv=gl.getAttribLocation(program,'uv');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,16,0);gl.enableVertexAttribArray(uv);gl.vertexAttribPointer(uv,2,gl.FLOAT,false,16,8);
  this.planarUniform=gl.getUniformLocation(program,'planar');this.alphaUniform=gl.getUniformLocation(program,'hasAlpha');for(let n=1;n<4;n++)gl.uniform1i(gl.getUniformLocation(program,['','planeU','planeV','planeA'][n]),n);this.rect=gl.getUniformLocation(program,'rect');this.opacity=gl.getUniformLocation(program,'opacity');gl.uniform1i(gl.getUniformLocation(program,'tex'),0);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.clearColor(0,0,0,1);
  this.maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.lost=true;});
 }
 render(decks,layers,master){
  const gl=this.gl;if(this.lost)throw new Error('GPU 컨텍스트가 중단되었습니다. 앱을 다시 실행해 주세요.');
  const config=JSON.stringify([master.width,master.height,layers]);
  if(this.previousConfig===config&&this.previousDecks?.length===decks.length&&this.previousDecks.every((d,i)=>d===decks[i]&&this.previousKeys[i]===d?.renderKey))return;
  this.previousConfig=config;this.previousDecks=[...decks];this.previousKeys=decks.map(d=>d?.renderKey);this.revision=(this.revision||0)+1;
  gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clear(gl.COLOR_BUFFER_BIT);
  const live=new Set(decks.filter(Boolean));for(const [d,t] of this.textures){if(!live.has(d)){if(!t.external){gl.deleteTexture(t.tex);for(const tex of t.extraPlanes||[])gl.deleteTexture(tex);}this.textures.delete(d);}}
  decks.forEach((deck,i)=>{
   const layer=layers[i];if(!deck?.ready||!deck.element||!layer.enabled||layer.opacity<=0)return;
   const gpu=this.loopTextures?.get(deck.cache);
   let rec=this.textures.get(deck);if(gpu?.ready){if(!rec){rec={external:true};this.textures.set(deck,rec);}rec.tex=gpu.textures[deck.frameIndex];rec.key=deck.renderKey;rec.hasFrame=true;}
   if(!rec){const tex=gl.createTexture();rec={tex,key:null,hasFrame:false};this.textures.set(deck,rec);gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
   gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,rec.tex);
   const image=deck.media.kind==='image',key=deck.renderKey;
   if(rec.key!==key&&(deck.cache||image||!deck.element.seeking&&deck.element.readyState>=2)){
    const uploadAt=performance.now();let operation='texImage2D';
    try{
     if(deck.uploadPlanar){
      operation='planarBufferUpload';const p=deck.uploadPlanar;rec.extraPlanes??=[];const format=this.webgl2?gl.RED:gl.LUMINANCE,internal=this.webgl2?gl.R8:gl.LUMINANCE;
      p.planes.forEach((plane,n)=>{let tex=n===0?rec.tex:rec.extraPlanes[n-1];if(!tex){tex=gl.createTexture();rec.extraPlanes[n-1]=tex;gl.activeTexture(gl.TEXTURE0+n);gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
       gl.activeTexture(gl.TEXTURE0+n);gl.bindTexture(gl.TEXTURE_2D,tex);const data=p.bytes.subarray(plane.offset,plane.offset+plane.width*plane.height);if(rec.planarSize===p.size){gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,plane.width,plane.height,format,gl.UNSIGNED_BYTE,data);this.metrics.updates++;}else{gl.texImage2D(gl.TEXTURE_2D,0,internal,plane.width,plane.height,0,format,gl.UNSIGNED_BYTE,data);this.metrics.allocations++;}});rec.planarSize=p.size;rec.width=deck.width;rec.height=deck.height;gl.activeTexture(gl.TEXTURE0);
     }else if(rec.width===deck.width&&rec.height===deck.height&&!rec.planarSize){operation='texSubImage2D';gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,deck.renderSource);this.metrics.updates++;}
     else{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,deck.renderSource);rec.width=deck.width;rec.height=deck.height;rec.planarSize=null;this.metrics.allocations++;}
     rec.key=key;rec.hasFrame=true;this.lastError=null;
    }catch(e){this.previousConfig=null;this.lastError=e.message;return;}
    finally{const ms=performance.now()-uploadAt;this.metrics.maxUploadMs=Math.max(this.metrics.maxUploadMs,ms);if(ms>20){this.metrics.slowCalls.push({operation,ms,at:uploadAt});if(this.metrics.slowCalls.length>30)this.metrics.slowCalls.shift();}}
   }
   if(!rec.hasFrame)return;
   const W=master.width,H=master.height;let rw=W,rh=H;
   if(layer.fit!=='stretch'){const scale=layer.fit==='cover'?Math.max(W/deck.width,H/deck.height):Math.min(W/deck.width,H/deck.height);rw=deck.width*scale;rh=deck.height*scale;}
   gl.uniform4f(this.rect,layer.x*2/W,-layer.y*2/H,rw/W*layer.scale,rh/H*layer.scale);gl.uniform1f(this.opacity,layer.opacity);gl.uniform1f(this.planarUniform,deck.uploadPlanar?1:0);gl.uniform1f(this.alphaUniform,deck.uploadPlanar?.planes.length===4?1:0);for(let n=1;n<4;n++){gl.activeTexture(gl.TEXTURE0+n);gl.bindTexture(gl.TEXTURE_2D,rec.extraPlanes?.[n-1]||rec.tex);}gl.activeTexture(gl.TEXTURE0);const drawAt=performance.now();gl.drawArrays(gl.TRIANGLES,0,6);const ms=performance.now()-drawAt;this.metrics.maxDrawMs=Math.max(this.metrics.maxDrawMs,ms);if(ms>20){this.metrics.slowCalls.push({operation:'drawArrays',ms,at:drawAt});if(this.metrics.slowCalls.length>30)this.metrics.slowCalls.shift();}
  });
 }
}
export class PlaybackEngine {
 constructor(pgm,pvw,layers,output){this.layers=layers;this.output=output;this.pgm=new Compositor(pgm);this.pvw=new Compositor(pvw);this.active=Array(4).fill(null);this.prepared=null;this.token=0;this.frames=0;this.fps=0;this.last=0;this.fpsAt=performance.now();this.running=false;this.onEnd=()=>{};this.onError=()=>{};}
 assertGPU(){if(this.contextError||this.pgm.lost||this.pvw.lost||this.pgm.gl.isContextLost()||this.pvw.gl.isContextLost())throw new Error('GPU 컨텍스트가 중단되었습니다. 앱을 다시 실행해 주세요.');}
 disposeRetired(){for(const old of this.retired||[])old.dispose();this.retired=[];}
 async prepare(cue,media){
  this.assertGPU();
  const token=++this.token;if(this.prepared){this.prepared.dispose();this.prepared=null;}
  const deck=new Deck(media,cue,this.output.fps);
  try{await deck.load();if(token!==this.token){deck.dispose();return false;}await this.pgm.prime(deck,()=>new Promise(resolve=>(this.presentationWaiters??=[]).push(resolve)),()=>token!==this.token);if(token!==this.token){deck.dispose();return false;}this.prepared=deck;return true;}catch(e){deck.dispose();if(token===this.token)throw e;return false;}
 }
 clearPreview(){++this.token;this.prepared?.dispose();this.prepared=null;}
 async go(){
  this.assertGPU();
  const next=this.prepared;if(!next?.ready)throw new Error('다음 큐가 준비되지 않았습니다.');
  const generation=this.generation||0;
  await next.play(this.layers[next.cue.layer].mute);
  try{this.assertGPU();}catch(e){next.pause();throw e;}
  if(generation!==(this.generation||0)||this.prepared!==next){next.pause();throw Object.assign(new Error('정지 또는 프로젝트 변경으로 큐 전환을 취소했습니다.'),{code:'PLAYBACK_CANCELLED'});}
  const old=this.active[next.cue.layer];this.active[next.cue.layer]=next;this.prepared=null;this.running=true;
  // Release the old decoder only after the newly active deck has been rendered.
  if(old)(this.retired??=[]).push(old);return next;
 }
 hold(){this.generation=(this.generation||0)+1;this.active.forEach(d=>d?.pause());this.prepared?.pause();for(const old of this.retired||[])old.pause();this.running=false;}
 resume(){this.assertGPU();this.active.forEach((d,i)=>{if(d&&!d.ended)d.play(this.layers[i].mute).catch(e=>this.onError(e));});this.running=true;}
 black(){this.generation=(this.generation||0)+1;this.prepared?.pause();this.active.forEach(d=>d?.dispose());this.active.fill(null);this.disposeRetired();this.running=false;}
 resize(output){if(this.active.some(Boolean))throw new Error('캔버스 크기를 바꾸기 전에 BLACK으로 정지하세요.');if(Math.max(output.width,output.height)>this.pgm.maxTexture)throw new Error('GPU 최대 텍스처 크기를 초과합니다.');this.clearPreview();this.output=output;this.deadline=0;this.frames=0;this.fps=0;this.fpsAt=performance.now();this.pgm.canvas.width=output.width;this.pgm.canvas.height=output.height;this.pvw.canvas.width=960;this.pvw.canvas.height=Math.max(64,Math.round(960*output.height/output.width));}
 render(now){
  if(this.pgm.lost||this.pvw.lost){if(!this.contextError){this.contextError=true;this.hold();this.disposeRetired();this.fps=0;this.onError(new Error('GPU 컨텍스트가 중단되었습니다. 앱을 다시 실행해 주세요.'));}}
  else{
  try{
   this.active.forEach(d=>{if(d?.tick(now))this.onEnd(d);});
   this.pgm.render(this.active,this.layers,this.output);
   const preview=[...this.active];if(this.prepared)preview[this.prepared.cue.layer]=this.prepared;
   this.pvw.render(this.prepared?preview:[],this.layers,this.output);
   this.disposeRetired();this.afterPresent?.();
   this.frames++;if(now-this.fpsAt>=1000){this.fps=this.frames*1000/(now-this.fpsAt);this.frames=0;this.fpsAt=now;}
  }catch(e){this.onError(e);this.hold();}
  }
  // RAF is throttled for hidden operator windows. The local render clock must
  // keep driving a separate visible PGM output while the operator minimizes UI.
  for(const resolve of this.presentationWaiters||[])resolve();this.presentationWaiters=[];
  const interval=1000/this.output.fps;this.deadline=(this.deadline||now)+interval;
  if(this.deadline<performance.now()-interval)this.deadline=performance.now()+interval;
  if(this.active.some(d=>d?.playing&&d.behindFrames>0))this.deadline=Math.min(this.deadline,performance.now()+Math.max(1,interval/2));
  this.timer=setTimeout(()=>this.render(performance.now()),Math.max(1,this.deadline-performance.now()));
 }
 source(name){if(name==='pgm')return this.pgm.canvas;if(name==='pvw')return this.pvw.canvas;if(/^layer[0-3]$/.test(name))return this.active[Number(name.at(-1))]?.viewSource()||null;return null;}
}
