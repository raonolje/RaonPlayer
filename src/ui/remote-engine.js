// The operator owns controls only. VideoFrames, decoders, audio and output
// canvases live in a different renderer process; no full-resolution video-frame IPC or copies.
export class RemoteEngine {
 constructor(pgm,pvw,layers,output){
  this.layers=layers;this.output=output;this.active=Array(4).fill(null);this.prepared=null;this.fps=0;this.generation=0;this.onEnd=()=>{};this.onError=()=>{};this.onAuto=()=>{};this.onState=()=>{};this.onOutputClosed=()=>{};this.sequence=0;this.decks=new Map();this.pgm={canvas:pgm,maxTexture:0};this.pvw={canvas:pvw};
  window.native.onEngineEvent(({event,data})=>{if(event==='snapshot'){this.apply(data);window.native.snapshotAck();}if(event==='error')this.onError(new Error(data));if(event==='auto'){this.apply(data.snapshot);this.onAuto(data.cue);}if(event==='outputClosed')this.onOutputClosed(data);});
 }
 async init(){window.native.snapshotAck();await this.command('init',{layers:this.layers,output:this.output});
  window.native.onEnginePreview(async images=>{if(this.previewBusy)return;this.previewBusy=true;try{for(const source of Object.keys(images)){const bitmap=await createImageBitmap(new Blob([images[source]],{type:'image/jpeg'}));const canvas=this[source].canvas,ctx=canvas.getContext('2d',{alpha:false});ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();}}finally{this.previewBusy=false;window.native.previewAck();}});window.native.previewAck();
 }

 apply(s){if(!s||s.sequence<=this.sequence)return;const prior=this.active.map(d=>d?.uid).join(',')+'|'+this.prepared?.uid;this.sequence=s.sequence;const live=new Set();const update=d=>{if(!d)return null;live.add(d.uid);let proxy=this.decks.get(d.uid);if(!proxy){proxy={setMuted:muted=>this.fire('mute',{uid:d.uid,muted}),dispose:()=>this.fire('dispose',{uid:d.uid})};this.decks.set(d.uid,proxy);}return Object.assign(proxy,d);};this.active=s.active.map(update);this.prepared=update(s.prepared);for(const id of this.decks.keys())if(!live.has(id))this.decks.delete(id);this.fps=s.fps;this.running=s.running;this.generation=Math.max(this.generation,s.generation);this.pgm.maxTexture=s.maxTexture;this.memory=s.memory;const current=this.active.map(d=>d?.uid).join(',')+'|'+this.prepared?.uid;if(prior!==current)this.onState();}
 async command(method,payload){const r=await window.native.engineCommand(method,payload);this.apply(r.snapshot);if(r.error)throw new Error(r.error);return r.value;}
 fire(method,payload){const p=this.command(method,payload);this.pending=p.catch(e=>this.onError(e));return p;}
 sync(state,lock=false){return this.fire('sync',{state,lock});}
 render(){}
 async prepare(cue,media){await this.pending;return this.command('prepare',{cue,media});}
 async go(){const generation=this.generation;await this.pending;if(generation!==this.generation)throw new Error('정지 또는 프로젝트 변경으로 큐 전환을 취소했습니다.');const d=await this.command('go');return this.decks.get(d.uid)||d;}
 hold(){++this.generation;return this.fire('hold');}
 resume(){return this.fire('resume');}
 black(){++this.generation;this.active=Array(4).fill(null);return this.fire('black');}
 clearPreview(){this.prepared=null;return this.fire('clearPreview');}
 resize(output){if(this.active.some(Boolean))throw new Error('캔버스 크기를 바꾸기 전에 BLACK으로 정지하세요.');this.output=output;this.pgm.canvas.width=output.width;this.pgm.canvas.height=output.height;this.pvw.canvas.width=960;this.pvw.canvas.height=Math.max(64,Math.round(960*output.height/output.width));return this.fire('resize',{output});}
 source(){return null;}
}
