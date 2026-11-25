// JPEG conversion belongs to the thumbnail worker, never the presentation task.
const canvases=new Map();
self.onmessage=async({data})=>{
 const images={};
 try{
  for(const [key,bitmap] of Object.entries(data)){
   try{
    let canvas=canvases.get(key);
    if(!canvas){canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvases.set(key,canvas);}
    if(canvas.width!==bitmap.width)canvas.width=bitmap.width;
    if(canvas.height!==bitmap.height)canvas.height=bitmap.height;
    canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0);
    images[key]=await(await canvas.convertToBlob({type:'image/jpeg',quality:.8})).arrayBuffer();
   }finally{bitmap.close();}
  }
  self.postMessage({images},Object.values(images));
 }catch(e){for(const bitmap of Object.values(data))bitmap.close();self.postMessage({error:e.message});}
};
