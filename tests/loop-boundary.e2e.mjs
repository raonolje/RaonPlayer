import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=path.resolve(process.env.LOOP_RESULTS||'../loop-fix-test'),assets=path.resolve(process.env.REAL_ASSETS||'../youtube-test/media');await fs.mkdir(out,{recursive:true});
const args=[`--user-data-dir=${path.resolve('../../work/loop-fix-profile')}`];
const options=process.env.PACKAGED?{executablePath:path.resolve('../player-windows-v0.2/RaonLocalPlayer-win32-x64/RaonLocalPlayer.exe'),args}:{args:[process.cwd(),...args]};
const app=await electron.launch({...options,env:{...process.env,PLAYER_TEST:'1'},timeout:30000}),result={date:new Date().toISOString(),packaged:!!process.env.PACKAGED,errors:[],scenarios:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});await page.waitForFunction(()=>!!window.playerDiagnostics);
 await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
 const files=['bunny-youtube.mp4','sintel-youtube.mp4','steel-youtube.mp4',...Array.from({length:4},(_,i)=>`actor0${i+1}-alpha.webm`),'actor01-pingpong.webm'];
 const media=await page.evaluate(p=>window.native.importPaths(p),files.map(f=>path.join(assets,f)));assert.ok(media.every(m=>!m.error),JSON.stringify(media));
 const layers=()=>Array.from({length:4},()=>({opacity:1,enabled:true,mute:true,fit:'contain',x:0,y:0,scale:1}));
 const project=(cues,ls=layers())=>({schema:'raon-player/1',name:'실영상 무공백 루프 검증',media,cues,layers:ls,output:{width:1920,height:1080,fps:60},views:['pgm','pvw','layer0','layer1','layer2','layer3','pgm','pvw','layer0','layer3']});
 async function start(p){await page.evaluate(p=>window.playerDiagnostics.loadProject(p),p);for(let i=0;i<p.cues.length;i++)await page.evaluate(()=>window.playerDiagnostics.go());await sleep(1000);}
 async function measure(label,seconds){
  await page.evaluate(()=>{
   const e=window.playerDiagnostics.getEngine(),original=e.pgm.render.bind(e.pgm);
   const c=new OffscreenCanvas(48,27),ctx=c.getContext('2d',{willReadFrequently:true});
   window.boundaryAudit={layers:e.active.filter(Boolean).map(d=>({name:d.media.name,fps:d.cache.fps,frames:d.cache.frames,wraps:0,changes:0,skips:0,boundarySkips:0,maxBehindFrames:0,maxChangeGapMs:0,maxBoundaryGapMs:0,textureMismatches:0,previous:null,previousAt:null,wrapSamples:[]})),samples:0,black:0,glErrors:[],started:performance.now()};
   e.pgm.render=(decks,layers,output)=>{
    original(decks,layers,output);const now=performance.now();window.boundaryAudit.samples++;
    e.active.filter(Boolean).forEach((d,i)=>{const a=window.boundaryAudit.layers[i],index=e.pgm.textures.get(d)?.key;if(index!==d.frameIndex)a.textureMismatches++;a.maxBehindFrames=Math.max(a.maxBehindFrames,d.behindFrames||0);
     if(a.previous!==null&&d.absoluteFrame!==a.previous){const gap=now-a.previousAt,step=d.absoluteFrame-a.previous;const boundary=Math.floor(d.absoluteFrame/d.cache.frames)>Math.floor(a.previous/d.cache.frames);
      a.maxChangeGapMs=Math.max(a.maxChangeGapMs,gap);a.changes++;if(step!==1)a.skips+=Math.max(0,step-1);
      if(boundary){a.wraps++;if(step!==1)a.boundarySkips++;a.maxBoundaryGapMs=Math.max(a.maxBoundaryGapMs,gap);a.wrapSamples.push({from:a.previous%d.cache.frames,to:d.frameIndex,step,gapMs:gap});}
      a.previousAt=now;
     }else if(a.previous===null)a.previousAt=now;
     a.previous=d.absoluteFrame;
    });
    ctx.drawImage(e.pgm.canvas,0,0,48,27);const pixels=ctx.getImageData(0,0,48,27).data;let peak=0,sum=0;for(let i=0;i<pixels.length;i+=4){sum+=pixels[i]+pixels[i+1]+pixels[i+2];peak=Math.max(peak,pixels[i],pixels[i+1],pixels[i+2]);}if(sum/(48*27*3)<2&&peak<8)window.boundaryAudit.black++;
    const error=e.pgm.gl.getError();if(error)window.boundaryAudit.glErrors.push(error);
   };window.stopBoundaryAudit=()=>{e.pgm.render=original;return {...window.boundaryAudit,elapsed:(performance.now()-window.boundaryAudit.started)/1000,renderFps:e.fps};};
  });
  for(let i=0;i<seconds/10;i++){await sleep(10000);console.log(`${label}: ${(i+1)*10}s`);}
  const audit=await page.evaluate(()=>window.stopBoundaryAudit());audit.label=label;result.scenarios.push(audit);
  await fs.writeFile(path.join(out,'loop-results.json'),JSON.stringify(result,null,2));
  assert.equal(audit.black,0,`${label}: black output`);assert.deepEqual(audit.glErrors,[]);
  for(const layer of audit.layers){assert.ok(layer.wraps>=2,JSON.stringify(layer));assert.equal(layer.textureMismatches,0);assert.equal(layer.boundarySkips,0,JSON.stringify(layer));assert.ok(layer.maxBoundaryGapMs<100,JSON.stringify(layer));}
  return audit;
 }
 const alpha=media.slice(3,7).map((m,i)=>({id:`alpha-${i}`,name:`실사 알파 ${i+1}`,mediaId:m.id,layer:i,in:0,out:m.duration,mode:'loop',auto:false}));
 await start(project(alpha,layers().map((l,i)=>({...l,scale:.48,x:i%2?450:-450,y:i<2?-250:250}))));
 const p1=app.waitForEvent('window');await page.evaluate(()=>{window.playerDiagnostics.openOutput('pgm');return true;});const pgm=await p1;
 const p2=app.waitForEvent('window');await page.evaluate(()=>{window.playerDiagnostics.openOutput('multiview');return true;});const multi=await p2;
 await measure('4 real alpha videos + PGM + 10-slot multiview',60);
 await page.screenshot({path:path.join(out,'four-alpha-fixed.png')});await pgm.screenshot({path:path.join(out,'pgm-fixed.png')});await multi.screenshot({path:path.join(out,'multiview-fixed.png')});
 const before=await page.evaluate(()=>{const e=window.playerDiagnostics.getEngine();e.hold();return e.active.map(d=>d.time);});await sleep(400);const after=await page.evaluate(()=>window.playerDiagnostics.getEngine().active.map(d=>d.time));assert.ok(before.every((v,i)=>v===after[i]));await page.evaluate(()=>window.playerDiagnostics.getEngine().resume());await sleep(150);result.holdResume=true;
 await pgm.close();await multi.close();
 for(let i=0;i<3;i++){
  const m=media[i];await start(project([{id:`ordinary-${i}`,name:m.name,mediaId:m.id,layer:0,in:.5,out:2.5,mode:'loop',auto:false}]));
  await measure(m.name+' nonzero IN loop',10);
  result.scenarios.at(-1).audio=await page.evaluate(()=>{const d=window.playerDiagnostics.getEngine().active[0];d.setMuted(false);return {hasAudio:!!d.cache.audio,loop:d.audioSource?.loop,start:d.audioSource?.loopStart,end:d.audioSource?.loopEnd,gain:d.gain?.gain.value};});
 }
 const pm=media.at(-1);await start(project([{id:'ping',name:'실사 알파 핑퐁',mediaId:media[3].id,playbackMediaId:pm.id,layer:0,in:0,out:4,mode:'pingpong',auto:false}]));await measure('real alpha pingpong cache wrap',20);
 // Record separately so screen recording does not contaminate the timing run.
 await start(project(alpha,layers().map((l,i)=>({...l,scale:.48,x:i%2?450:-450,y:i<2?-250:250}))));
 const recording=await page.evaluate(async()=>{const stream=window.playerDiagnostics.getEngine().pgm.canvas.captureStream(60),chunks=[],rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:6000000});return await new Promise(resolve=>{rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=async()=>{const data=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(let i=0;i<data.length;i+=32768)binary+=String.fromCharCode(...data.subarray(i,i+32768));stream.getTracks().forEach(t=>t.stop());resolve(btoa(binary));};rec.start();setTimeout(()=>rec.stop(),8000);});});
 await fs.writeFile(path.join(out,'loop-fixed-live.webm'),Buffer.from(recording,'base64'));
 await page.evaluate(()=>{const e=window.playerDiagnostics.getEngine();e.black();e.clearPreview();});
 result.memoryAfterBlack=await page.evaluate(async()=>{const {loopMemory}=await import('./loop-cache.js');return loopMemory();});assert.equal(result.memoryAfterBlack.reserved,0);
 assert.deepEqual(result.errors,[]);result.completed=true;await fs.writeFile(path.join(out,'loop-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result.scenarios.map(s=>({label:s.label,black:s.black,layers:s.layers.map(l=>({wraps:l.wraps,skips:l.skips,boundarySkips:l.boundarySkips,maxGap:l.maxChangeGapMs,boundaryGap:l.maxBoundaryGapMs}))})),null,2));
}catch(e){result.failure={message:e.message,stack:e.stack};await fs.writeFile(path.join(out,'loop-results.json'),JSON.stringify(result,null,2));throw e;}finally{await app.close();}
