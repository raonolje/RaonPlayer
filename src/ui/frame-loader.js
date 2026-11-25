// A short-lived loader keeps raw frame assembly and VideoFrame construction
// off the renderer's presentation clock. Transfer ownership, never pixel-copy
// a whole loop back through IPC on the operator thread.
self.onmessage=async({data:plan})=>{
 const frames=[];
 try{
  const response=await fetch(plan.url);if(!response.ok)throw new Error('반복 프레임을 읽지 못했습니다.');
  const reader=response.body.getReader(),buffer=new Uint8Array(plan.frameBytes);let filled=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;let offset=0;
   while(offset<value.length){const count=Math.min(value.length-offset,buffer.length-filled);buffer.set(value.subarray(offset,offset+count),filled);filled+=count;offset+=count;
    if(filled===buffer.length){if(frames.length>=plan.frames)throw new Error('반복 프레임 개수 오류');frames.push(new VideoFrame(buffer,{format:plan.format,codedWidth:plan.width,codedHeight:plan.height,timestamp:Math.round(frames.length*1e6/plan.fps),colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}}));filled=0;}
   }
  }}finally{reader.releaseLock();}
  if(filled||frames.length!==plan.frames)throw new Error('반복 프레임이 불완전합니다.');
  self.postMessage({frames},frames);
 }catch(e){for(const f of frames)f.close();self.postMessage({error:e.message});}
};
