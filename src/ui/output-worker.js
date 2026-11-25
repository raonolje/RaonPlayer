import {Compositor} from './engine.js';
let canvas,compositor,generation=0,queue=Promise.resolve();const decks=new Map();
const close=images=>{for(const image of Object.values(images||{}))image?.close();};
async function render(d){
 const drawAt=performance.now(),wrapped=[];
 try{
  if(d.generation!==generation)return;
  const W=Math.max(64,Math.round(d.width*d.pixelRatio)),H=Math.max(64,Math.round(d.height*d.pixelRatio));
  if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;compositor.previousConfig=null;}
  for(const [key,source] of Object.entries(d.images)){
   if(!source)continue;let frame=source;if(!(source instanceof VideoFrame)){frame=new VideoFrame(source,{timestamp:0});wrapped.push(frame);}
   let deck=decks.get(key);if(!deck){deck={media:{kind:'image'},ready:true};decks.set(key,deck);}
   // Upload cached planar pixels directly, bypassing lazy image decoding.
   let uploadPlanar=null;
   if((frame.format==='I420'||frame.format==='I420A')&&key.startsWith('layer')){
    const W=frame.displayWidth,H=frame.displayHeight,size=W+','+H+','+frame.format;
    if(deck.planar?.size!==size){let offset=0;const planes=[[W,H],[Math.ceil(W/2),Math.ceil(H/2)],[Math.ceil(W/2),Math.ceil(H/2)],...(frame.format==='I420A'?[[W,H]]:[])].map(([width,height])=>{const plane={width,height,offset};offset+=width*height;return plane;});deck.planar={size,planes,bytes:new Uint8Array(offset)};deck.pixelsKey=null;}
    if(deck.pixelsKey!==d.sourceKeys[key]){const copyAt=performance.now();await frame.copyTo(deck.planar.bytes,{layout:deck.planar.planes.map(p=>({offset:p.offset,stride:p.width}))});compositor.metrics.maxCopyMs=Math.max(compositor.metrics.maxCopyMs||0,performance.now()-copyAt);compositor.metrics.rawCopies=(compositor.metrics.rawCopies||0)+1;deck.pixelsKey=d.sourceKeys[key];}
    uploadPlanar=deck.planar;
   }
   if(d.generation!==generation)return;
   Object.assign(deck,{element:frame,renderSource:frame,renderKey:d.sourceKeys[key],width:frame.displayWidth,height:frame.displayHeight,uploadPlanar});
  }
  const views=d.source==='multiview'?d.views:[d.source],active=views.map(key=>d.images[key]?decks.get(key):null),layers=active.map((deck,i)=>{
   const r=d.source==='multiview'?d.rects[i]:{x:0,y:0,width:d.width,height:d.height};if(!deck)return {enabled:false,opacity:0,fit:'contain',scale:1,x:0,y:0};
   const whole=Math.min(d.width/deck.width,d.height/deck.height),fit=Math.min(r.width/deck.width,r.height/deck.height);
   return {enabled:true,opacity:1,fit:'contain',scale:fit/whole,x:r.x+r.width/2-d.width/2,y:r.y+r.height/2-d.height/2};
  });
  compositor.render(active,layers,{width:d.width,height:d.height});if(compositor.lastError)throw new Error(compositor.lastError);
  self.postMessage({generation:d.generation,frames:d.frames,source:d.source,width:d.width,height:d.height,enqueuedAt:d.enqueuedAt,capturedAt:d.capturedAt,sentWall:d.sentWall,workerStartWall:performance.timeOrigin+drawAt,workerEndWall:performance.timeOrigin+performance.now(),drawMs:performance.now()-drawAt,gpuMetrics:performance.now()-drawAt>20?compositor.metrics:undefined});
 }catch(e){if(d.generation===generation)self.postMessage({generation:d.generation,error:e.message});}
 finally{for(const frame of wrapped)frame.close();close(d.images);}
}
self.onmessage=({data:d})=>{
 if(d.kind==='init'){canvas=d.canvases[0];compositor=new Compositor(canvas);self.postMessage({kind:'ready'});return;}
 if(d.kind==='gpu-status'){self.postMessage({kind:'gpu-status',request:d.request,error:compositor.gl.getError()});return;}
 if(d.kind==='configure'||d.kind==='disable'){
  generation=d.generation;for(const rec of compositor.textures.values()){compositor.gl.deleteTexture(rec.tex);for(const tex of rec.extraPlanes||[])compositor.gl.deleteTexture(tex);}compositor.textures.clear();compositor.previousConfig=null;decks.clear();canvas.width=64;canvas.height=64;return;
 }
 if(d.kind==='render')queue=queue.then(()=>render(d));
};
