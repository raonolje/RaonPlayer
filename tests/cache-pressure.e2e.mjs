import {_electron as electron} from 'playwright';import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const out=path.resolve(process.env.TEST_OUT||'../diagnostic-v05');await fs.mkdir(out,{recursive:true});const args=[`--user-data-dir=${path.resolve('../../work/gpu-pressure-v05-profile')}`];
const app=await electron.launch({...process.env.HARD_EXE?{executablePath:path.resolve(process.env.HARD_EXE),args}:{args:[process.cwd(),...args]},env:{...process.env,PLAYER_TEST:'1'}});
const result={date:new Date().toISOString(),errors:[],checks:[]};let page,host;
try{
 await app.firstWindow();for(let i=0;i<100&&!page;i++){page=app.windows().find(p=>p.url().startsWith('player://app/'));if(!page)await new Promise(r=>setTimeout(r,100));}await page.waitForFunction(()=>!!window.playerDiagnostics);host=app.windows().find(p=>p.url().endsWith('/render-host.html'));
 for(const p of [page,host])p.on('pageerror',e=>result.errors.push(e.message));
 const [media]=await page.evaluate(paths=>window.native.importPaths(paths),[path.resolve('../youtube-test/media/bunny-youtube.mp4')]);
 await page.evaluate(async media=>{await window.playerDiagnostics.loadProject({schema:'raon-player/1',name:'GPU 메모리 압박',media:[media],cues:[{id:'on-air',name:'ON AIR',mediaId:media.id,layer:0,in:0,out:2,mode:'loop',auto:false}],layers:Array.from({length:4},()=>({enabled:true,opacity:1,mute:true,fit:'contain',scale:1,x:0,y:0})),output:{width:1920,height:1080,fps:60},views:Array(10).fill('pgm')});await window.playerDiagnostics.go();},media);
 const stats=()=>host.evaluate(async()=>{const e=window.playbackEngine,{loopMemory}=await import('./loop-cache.js');return {cpu:loopMemory(),gpu:e.pgm.gpuMemory(),frame:e.active[0].absoluteFrame,playing:e.active[0].playing,id:e.active[0].cue.id};});
 const before=await stats();
 await assert.rejects(page.evaluate(media=>window.playerDiagnostics.getEngine().prepare({id:'gpu-over-budget',name:'GPU 예산 초과',mediaId:media.id,layer:0,in:.125,out:3.125,mode:'loop'},media),media),/GPU.*2 GiB/);
 const rejected=await stats();assert.deepEqual(rejected.cpu,before.cpu);assert.deepEqual(rejected.gpu,before.gpu);assert.equal(rejected.playing,true);assert.equal(rejected.id,'on-air');assert.ok(rejected.frame>before.frame);result.checks.push({name:'GPU budget rejection rolls back CPU reservation without disturbing on-air frames',before,rejected});
 for(let i=0;i<5;i++){
  const preparing=page.evaluate(({media,i})=>window.playerDiagnostics.getEngine().prepare({id:'cancel-'+i,name:'준비 취소',mediaId:media.id,layer:0,in:.125,out:1.125,mode:'loop'},media),{media,i});
  await host.waitForFunction(()=>window.playbackEngine.pgm.gpuMemory().entries===2);
  await page.evaluate(()=>window.playerDiagnostics.getEngine().clearPreview());assert.equal(await preparing,false);
  const cancelled=await stats();assert.deepEqual(cancelled.cpu,before.cpu);assert.deepEqual(cancelled.gpu,before.gpu);assert.equal(cancelled.playing,true);
 }
 result.checks.push({name:'Five cancellations during GPU upload release every pending allocation',count:5,after:await stats()});
 await page.evaluate(async()=>{await window.playerDiagnostics.getEngine().black();await window.playerDiagnostics.getEngine().clearPreview();});const released=await host.evaluate(async()=>({cpu:(await import('./loop-cache.js')).loopMemory(),gpu:window.playbackEngine.pgm.gpuMemory()}));assert.equal(released.cpu.reserved,0);assert.equal(released.gpu.reserved,0);assert.deepEqual(result.errors,[]);result.released=released;result.passed=true;
}catch(e){result.failure=e.stack;throw e;}finally{await app.close();await fs.writeFile(path.join(out,'cache-pressure.json'),JSON.stringify(result,null,2));}
