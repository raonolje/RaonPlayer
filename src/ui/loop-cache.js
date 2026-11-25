// Prepare reusable VideoFrames from a bounded streaming buffer. Repeated
// playback does not allocate/copy an entire picture on every render tick.
const caches=new Map(),budget=1024*1024*1024;
let reserved=0,context;
export const loopAudio=()=>context??=new AudioContext({sampleRate:48000});
async function readBytes(url,size){
 const response=await fetch(url);if(!response.ok)throw new Error('반복 캐시를 읽지 못했습니다.');
 const bytes=new Uint8Array(size),reader=response.body.getReader();let offset=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.length>size)throw new Error('반복 캐시 크기 오류');bytes.set(value,offset);offset+=value.length;}}
 finally{reader.releaseLock();}
 if(offset!==size)throw new Error('반복 캐시가 불완전합니다.');return bytes;
}
async function readFrames(plan,entry){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./frame-loader.js',import.meta.url));
  const timer=setTimeout(()=>{worker.terminate();reject(new Error('반복 프레임 준비 시간이 초과되었습니다.'));},120000);
  const cleanup=()=>{clearTimeout(timer);worker.terminate();};
  worker.onmessage=({data})=>{cleanup();if(data.error)reject(new Error(data.error));else{entry.frames=data.frames;resolve(data.frames);}};
  worker.onerror=e=>{cleanup();reject(new Error(e.message||'반복 프레임 작업 오류'));};worker.postMessage(plan);
 });
}
export async function acquireLoop(media,cue,outputFps=60){
 const key=JSON.stringify([media.path,media.modified,media.size,cue.playbackMediaId?0:cue.in,cue.playbackMediaId?media.duration:cue.out,outputFps]);
 let entry=caches.get(key);
 if(!entry){
  entry={refs:0,bytes:0};caches.set(key,entry);
  entry.promise=(async()=>{
   const plan=await window.native.loopFrames(media.id,cue,outputFps);
   // PCM staging plus planar AudioBuffer coexist briefly while preparing.
   entry.bytes=plan.bytes+plan.audioBytes*2;
   if(reserved+entry.bytes>budget){entry.bytes=0;throw new Error('활성 영상과 다음 큐의 무공백 캐시 합계가 1 GiB를 초과합니다. 반복 구간을 줄이세요.');}
   reserved+=entry.bytes;
   const frames=await readFrames(plan,entry);let audio=null;
   if(plan.audioUrl){const bytes=await readBytes(plan.audioUrl,plan.audioBytes),samples=new Float32Array(bytes.buffer);audio=loopAudio().createBuffer(2,samples.length/2,48000);for(let c=0;c<2;c++){const channel=audio.getChannelData(c);for(let i=0;i<channel.length;i++)channel[i]=samples[i*2+c];}}
   return {...plan,framesData:frames,audio};
  })();
 }
 entry.refs++;
 let released=false;
 const release=()=>{if(released)return;released=true;if(--entry.refs===0){caches.delete(key);for(const frame of entry.frames||[])frame.close();entry.frames=null;reserved-=entry.bytes;entry.bytes=0;}};
 try{return {cache:await entry.promise,release};}catch(e){release();throw e;}
}
export const loopMemory=()=>({reserved,budget,entries:caches.size});
