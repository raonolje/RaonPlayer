import {_electron as electron} from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
 const args=[`--user-data-dir=${path.resolve('../../work/loop-memory-profile')}`];
 const app=await electron.launch({...process.env.PACKAGED?{executablePath:path.resolve('../player-windows-v0.2/RaonLocalPlayer-win32-x64/RaonLocalPlayer.exe'),args}:{args:[process.cwd(),...args]},env:{...process.env,PLAYER_TEST:'1'}});
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.playerDiagnostics);
 const assets=path.resolve(process.env.REAL_ASSETS||'../youtube-test/media');
 const [media]=await page.evaluate(p=>window.native.importPaths([p]),path.join(assets,'bunny-youtube.mp4'));
 const result=await page.evaluate(async media=>{
  const {Deck}=await import('./engine.js'),{loopMemory}=await import('./loop-cache.js');
  const cue=(start)=>({id:'memory-'+start,mediaId:media.id,in:start,out:start+2,mode:'loop',layer:0});
  const a=new Deck(media,cue(.5)),shared=new Deck(media,cue(.5)),b=new Deck(media,cue(3)),excess=new Deck(media,cue(5));
  await a.load();const single=loopMemory();await shared.load();const sharedMemory=loopMemory();await b.load();
  let error=null;try{await excess.load();}catch(e){error=e.message;}const peak=loopMemory();
  a.dispose();shared.dispose();b.dispose();excess.dispose();return {single,sharedMemory,peak,error,released:loopMemory()};
 },media);
 assert.equal(result.single.reserved,result.sharedMemory.reserved);assert.match(result.error,/1 GiB/);assert.ok(result.peak.reserved<=result.peak.budget);assert.equal(result.released.reserved,0);
 const [alpha]=await page.evaluate(p=>window.native.importPaths([p]),path.join(assets,'actor01-alpha.webm'));
 result.alpha=await page.evaluate(async media=>{
  const {Deck}=await import('./engine.js');const d=new Deck(media,{id:'alpha-proof',mediaId:media.id,in:0,out:4,mode:'loop',layer:0});await d.load();
  const decoded=new Uint8Array(d.frame.allocationSize());await d.frame.copyTo(decoded);
  const e=window.playerDiagnostics.getEngine(),gl=e.pgm.gl;gl.clearColor(.04,.08,.12,1);
  e.pgm.render([d],[{enabled:true,opacity:1,fit:'contain',x:0,y:0,scale:1}],e.output);
  const scale=e.output.height/d.height,x=Math.round((e.output.width-d.width*scale)/2+2*scale),y=Math.round(e.output.height-2*scale);
  const pixel=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  const plane=d.width*d.height+2*Math.ceil(d.width/2)*Math.ceil(d.height/2),a=decoded[plane+2*d.width+2];
  d.dispose();gl.clearColor(0,0,0,1);return {sourceAlpha:a,outputPixel:Array.from(pixel),expectedBackground:[10,20,31,255],pixelLocation:[x,y]};
 },alpha);
 assert.equal(result.alpha.sourceAlpha,0);assert.ok(result.alpha.outputPixel.every((n,i)=>Math.abs(n-result.alpha.expectedBackground[i])<=1),JSON.stringify(result.alpha));
 await fs.writeFile(path.resolve('../loop-fix-test/memory-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await app.close();}
