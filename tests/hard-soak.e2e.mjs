import {_electron as electron} from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=path.resolve('../hard-test'),profile=path.resolve('../../work/hard-tests/soak-profile');await fs.mkdir(out,{recursive:true});
const seconds=Number(process.env.SOAK_SECONDS||600),args=[`--user-data-dir=${profile}`];
const app=await electron.launch({...process.env.HARD_EXE?{executablePath:path.resolve(process.env.HARD_EXE),args}:{args:[process.cwd(),...args]},env:{...process.env,PLAYER_TEST:'1'},timeout:30000});
const result={date:new Date().toISOString(),targetSeconds:seconds,packaged:!!process.env.HARD_EXE,errors:[],samples:[]};let page;
try{
 page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});await page.waitForFunction(()=>!!window.playerDiagnostics);
 await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
 const media=await page.evaluate(paths=>window.native.importPaths(paths),Array.from({length:4},(_,i)=>path.resolve('../youtube-test/media',`actor0${i+1}-alpha.webm`)));assert.ok(media.every(m=>m.alpha));
 const state={schema:'raon-player/1',name:'10분 실영상 하드 테스트',media,cues:media.map((m,i)=>({id:'soak-'+i,name:m.name,mediaId:m.id,layer:i,in:0,out:m.duration,mode:'loop',auto:false})),layers:media.map((m,i)=>({opacity:1,enabled:true,mute:true,fit:'contain',scale:.48,x:i%2?450:-450,y:i<2?-250:250})),output:{width:1920,height:1080,fps:60},views:['pgm','pvw','layer0','layer1','layer2','layer3','pgm','pvw','layer0','layer3']};
 await page.evaluate(s=>window.playerDiagnostics.loadProject(s),state);for(let i=0;i<4;i++)await page.evaluate(()=>window.playerDiagnostics.go());
 const children=[];for(const source of ['pgm','multiview']){const event=app.waitForEvent('window');await page.evaluate(s=>{window.playerDiagnostics.openOutput(s);return true;},source);children.push(await event);}
 await page.waitForTimeout(1000);
 await page.evaluate(()=>{
  const e=window.playerDiagnostics.getEngine(),original=e.pgm.render.bind(e.pgm),c=new OffscreenCanvas(32,18),ctx=c.getContext('2d',{willReadFrequently:true});
  window.soak={started:performance.now(),samples:0,black:0,glErrors:[],layers:e.active.map(d=>({name:d.media.name,frames:d.cache.frames,fps:d.cache.fps,changes:0,wraps:0,skips:0,boundarySkips:0,maxGapMs:0,maxBoundaryGapMs:0,maxBehindFrames:0,textureMismatches:0,previous:null,previousAt:null}))};
  e.pgm.render=(...args)=>{
   original(...args);const now=performance.now();window.soak.samples++;
   e.active.forEach((d,i)=>{const a=window.soak.layers[i];if(e.pgm.textures.get(d)?.key!==d.frameIndex)a.textureMismatches++;a.maxBehindFrames=Math.max(a.maxBehindFrames,d.behindFrames||0);
    if(a.previous!==null&&d.absoluteFrame!==a.previous){const step=d.absoluteFrame-a.previous,gap=now-a.previousAt;a.changes++;a.skips+=Math.max(0,step-1);a.maxGapMs=Math.max(a.maxGapMs,gap);
     if(Math.floor(d.absoluteFrame/d.cache.frames)>Math.floor(a.previous/d.cache.frames)){a.wraps++;if(step!==1)a.boundarySkips++;a.maxBoundaryGapMs=Math.max(a.maxBoundaryGapMs,gap);}a.previousAt=now;
    }else if(a.previous===null)a.previousAt=now;a.previous=d.absoluteFrame;
   });
   ctx.drawImage(e.pgm.canvas,0,0,32,18);const a=ctx.getImageData(0,0,32,18).data;let sum=0,peak=0;for(let i=0;i<a.length;i+=4){sum+=a[i]+a[i+1]+a[i+2];peak=Math.max(peak,a[i],a[i+1],a[i+2]);}if(peak<8&&sum/(32*18*3)<2)window.soak.black++;
   const err=e.pgm.gl.getError();if(err)window.soak.glErrors.push(err);
  };window.stopSoak=()=>{e.pgm.render=original;return {...window.soak,elapsed:(performance.now()-window.soak.started)/1000};};
 });
 for(let elapsed=0;elapsed<seconds;elapsed+=30){
  await page.waitForTimeout(Math.min(30,seconds-elapsed)*1000);
  const sample=await page.evaluate(async()=>{const e=window.playerDiagnostics.getEngine(),{loopMemory}=await import('./loop-cache.js');return {seconds:(performance.now()-window.soak.started)/1000,fps:e.fps,black:window.soak.black,wraps:window.soak.layers.map(a=>a.wraps),playing:e.active.map(d=>d.playing),memory:loopMemory(),rendererHeapUsed:performance.memory?.usedJSHeapSize};});
  sample.processMemory=await app.evaluate(({app})=>app.getAppMetrics().map(p=>({type:p.type,memory:p.memory,pid:p.pid})));
  result.samples.push(sample);await fs.writeFile(path.join(out,'soak-progress.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({seconds:Math.round(sample.seconds),fps:Math.round(sample.fps*10)/10,wraps:sample.wraps,black:sample.black,errors:result.errors.length}));
  assert.ok(sample.playing.every(Boolean),'A layer stopped during soak');assert.equal(result.errors.length,0,result.errors.join('\n'));
 }
 result.audit=await page.evaluate(()=>window.stopSoak());assert.equal(result.audit.black,0);assert.deepEqual(result.audit.glErrors,[]);
 for(const layer of result.audit.layers){assert.equal(layer.skips,0);assert.equal(layer.boundarySkips,0);assert.equal(layer.textureMismatches,0);assert.ok(layer.wraps>=Math.floor(seconds/layer.frames*layer.fps)-1);assert.ok(layer.maxBoundaryGapMs<100,JSON.stringify(layer));}
 assert.ok(result.samples.every(s=>s.memory.reserved===result.samples[0].memory.reserved),'Cache budget grew');
 await page.screenshot({path:path.join(out,'hard-test-player.png')});await children[0].screenshot({path:path.join(out,'hard-test-pgm.png')});await children[1].screenshot({path:path.join(out,'hard-test-multiview.png')});
 await page.evaluate(()=>{const e=window.playerDiagnostics.getEngine();e.black();e.clearPreview();});await page.waitForTimeout(100);result.memoryAfterBlack=await page.evaluate(async()=>{const {loopMemory}=await import('./loop-cache.js');return loopMemory();});assert.equal(result.memoryAfterBlack.reserved,0);
 result.passed=true;result.completed=true;await fs.writeFile(path.join(out,'soak-results.json'),JSON.stringify(result,null,2));console.log('SOAK PASSED');
}catch(e){result.failure={message:e.message,stack:e.stack};await fs.writeFile(path.join(out,'soak-results.json'),JSON.stringify(result,null,2));throw e;}finally{await app.close();}
