import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
const out=path.resolve(process.env.TEST_OUT||'../soak-20261023/v08-candidate');await fs.mkdir(out,{recursive:true});
const app=await electron.launch({...process.env.HARD_EXE?{executablePath:path.resolve(process.env.HARD_EXE),args:[`--user-data-dir=${path.resolve('../../work/planar-upload-profile')}`]}:{args:[process.cwd(),`--user-data-dir=${path.resolve('../../work/planar-upload-profile')}`]},env:{...process.env,PLAYER_TEST:'1'}});
const result={date:new Date().toISOString()};
try{
 await app.firstWindow();let host;for(let i=0;i<100&&!host;i++){host=app.windows().find(p=>p.url().endsWith('/render-host.html'));if(!host)await new Promise(r=>setTimeout(r,100));}
 result.formats=await host.evaluate(async()=>{
  const {Compositor}=await import('./engine.js');const rows=[];
  for(const format of ['I420','I420A'])for(const pattern of ['solid','edges']){
   const W=32,H=24,n=W*H,bytes=new Uint8Array(n*(format==='I420A'?2.5:1.5));bytes.fill(128);for(let i=n;i<n*1.5;i++)bytes[i]=format==='NV12'?(i%2?170:90):(i<n*1.25?90:170);if(pattern==='edges')for(let i=n;i<n*1.5;i++)bytes[i]=i%2?170:90;for(let y=0;y<H;y++)for(let x=0;x<W;x++){bytes[y*W+x]=16+Math.floor((x+y)*219/(W+H-2));if(format==='I420A')bytes[n*1.5+y*W+x]=x<W/3?0:x<2*W/3?128:255;}
   const frame=new VideoFrame(bytes,{format,codedWidth:W,codedHeight:H,timestamp:0,colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}});
   let offset=0;const planes=[[W,H],[W/2,H/2],[W/2,H/2],...(format==='I420A'?[[W,H]]:[])].map(([width,height])=>{const p={width,height,offset};offset+=width*height;return p;});const rgba={size:W+','+H+','+format,planes,bytes:new Uint8Array(offset)};await frame.copyTo(rgba.bytes,{layout:planes.map(p=>({offset:p.offset,stride:p.width}))});
   const render=pixels=>{const c=new OffscreenCanvas(W,H),comp=new Compositor(c),d={media:{kind:'image'},ready:true,element:frame,renderSource:frame,renderKey:1,width:W,height:H,uploadPlanar:pixels};comp.render([d],[{enabled:true,opacity:1,fit:'contain',scale:1,x:0,y:0}],{width:W,height:H});const data=new Uint8Array(n*4);comp.gl.readPixels(0,0,W,H,comp.gl.RGBA,comp.gl.UNSIGNED_BYTE,data);const error=comp.gl.getError();comp.gl.getExtension('WEBGL_lose_context')?.loseContext();return {data,error};};
   const a=render(null),b=render(rgba);let maxDelta=0;for(let i=0;i<a.data.length;i++)maxDelta=Math.max(maxDelta,Math.abs(a.data[i]-b.data[i]));rows.push({format,pattern,maxDelta,errors:[a.error,b.error],baselineTop:[...a.data.slice(0,4)],top:[...b.data.slice(0,4)],bottom:[...b.data.slice(-4)]});frame.close();
  }return rows;
 });
 for(const r of result.formats){assert.deepEqual(r.errors,[0,0]);assert.ok(r.maxDelta<=3,JSON.stringify(r));}result.passed=true;console.log(JSON.stringify(result));
}catch(e){result.failure=e.stack;throw e;}finally{await app.close();await fs.writeFile(path.join(out,'planar-upload.json'),JSON.stringify(result,null,2));}
