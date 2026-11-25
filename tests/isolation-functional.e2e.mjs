import {_electron as electron} from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=path.resolve(process.env.TEST_OUT||'../diagnostic-v05');await fs.mkdir(out,{recursive:true});
const args=[`--user-data-dir=${path.resolve('../../work/extreme-functional-profile')}`];
const app=await electron.launch({...process.env.HARD_EXE?{executablePath:path.resolve(process.env.HARD_EXE),args}:{args:[process.cwd(),...args]},env:{...process.env,PLAYER_TEST:'1'},timeout:30000});
const result={date:new Date().toISOString(),packaged:!!process.env.HARD_EXE,checks:[],errors:[]};let page,host;
async function check(name,fn){console.log('CHECK '+name);const start=Date.now();const evidence=await fn();result.checks.push({name,seconds:(Date.now()-start)/1000,evidence});}
try{
 await app.firstWindow();for(let i=0;i<100&&!page;i++){page=app.windows().find(p=>p.url().startsWith('player://app/'));if(!page)await new Promise(r=>setTimeout(r,100));}await page.waitForFunction(()=>!!window.playerDiagnostics,null,{timeout:30000});host=app.windows().find(p=>p.url().endsWith('/render-host.html'));
 for(const p of [page,host]){p.on('pageerror',e=>result.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});}
 await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
 const media=await page.evaluate(paths=>window.native.importPaths(paths),['bunny-youtube.mp4','sintel-youtube.mp4','steel-youtube.mp4','actor01-alpha.webm'].map(n=>path.resolve('../youtube-test/media',n)));
 const layers=Array.from({length:4},()=>({enabled:true,opacity:1,mute:true,fit:'contain',x:0,y:0,scale:1}));
 const base=cues=>({schema:'raon-player/1',name:'실영상 연속 전환',media,cues,layers,output:{width:1920,height:1080,fps:60},views:['pgm','pvw','layer0','layer1','layer2','layer3','pgm','pvw','layer0','layer3']});
 const cue=(i,mode='once')=>({id:'cut-'+i,name:'CUT '+i,mediaId:media[i%3].id,layer:0,in:.5,out:2.5,mode,auto:false});
 const load=p=>page.evaluate(p=>window.playerDiagnostics.loadProject(p),p);
 await check('1000 preloaded real-footage CUTs, GPU pixel audit',async()=>{
  await load(base(Array.from({length:1001},(_,i)=>cue(i))));await page.evaluate(()=>window.playerDiagnostics.go());
  await host.evaluate(()=>{const e=window.playbackEngine,original=e.pgm.render.bind(e.pgm),c=new OffscreenCanvas(32,18),ctx=c.getContext('2d',{willReadFrequently:true});window.cutAudit={samples:0,black:0,maxRenderGap:0,last:performance.now()};e.pgm.render=(...args)=>{original(...args);const a=window.cutAudit,now=performance.now();a.maxRenderGap=Math.max(a.maxRenderGap,now-a.last);a.last=now;a.samples++;ctx.drawImage(e.pgm.canvas,0,0,32,18);const pixels=ctx.getImageData(0,0,32,18).data;let peak=0;for(let i=0;i<pixels.length;i+=4)peak=Math.max(peak,pixels[i],pixels[i+1],pixels[i+2]);if(peak<8)a.black++;};window.stopCut=()=>{e.pgm.render=original;return window.cutAudit;};});
  const times=[];for(let i=0;i<1000;i++){const start=Date.now();await page.evaluate(()=>window.playerDiagnostics.go());times.push(Date.now()-start);if((i+1)%100===0)console.log('CUT '+(i+1));}
  const audit=await host.evaluate(()=>window.stopCut());assert.equal(audit.black,0);assert.ok(audit.samples>=1000);assert.equal(await host.evaluate(()=>window.playbackEngine.active[0].cue.id),'cut-1000');return {...audit,count:1000,meanGoAndPrepareMs:times.reduce((a,b)=>a+b,0)/times.length,maxGoAndPrepareMs:Math.max(...times)};
 });
 await check('Portrait canvas, FIT/COVER/STRETCH, 30fps loop cap and live-resize rejection',async()=>{
  const p=base([{...cue(0,'loop'),in:0,out:1}]);p.output={width:720,height:1280,fps:30};await load(p);await page.evaluate(()=>window.playerDiagnostics.go());
  const native=await host.evaluate(()=>({fps:window.playbackEngine.active[0].cache.fps,width:window.playbackEngine.pgm.canvas.width,height:window.playbackEngine.pgm.canvas.height}));assert.deepEqual(native,{fps:30,width:720,height:1280});
  await assert.rejects(page.evaluate(()=>window.playerDiagnostics.getEngine().resize({width:640,height:640,fps:60})),/BLACK/);
  const pixels=[];for(const fit of ['contain','cover','stretch']){await page.evaluate(async fit=>{const s=window.playerDiagnostics.getState();s.layers[0].fit=fit;await window.playerDiagnostics.getEngine().sync(s);},fit);await host.waitForTimeout(50);pixels.push(await page.evaluate(()=>window.playerDiagnostics.readPixel(360,1100)));}
  assert.ok(pixels[0].slice(0,3).every(v=>v===0));assert.ok(pixels[1].slice(0,3).some(v=>v>8));assert.ok(pixels[2].slice(0,3).some(v=>v>8));return {native,pixels};
 });
 await check('20 ordered autosaves, newest recovery and cache release',async()=>{
  const names=await page.evaluate(async()=>{const s=window.playerDiagnostics.getState();await Promise.all(Array.from({length:20},(_,i)=>window.native.autosave({...s,name:'ordered-'+i})));const restored=await window.native.recovery();const e=window.playerDiagnostics.getEngine();await e.black();await e.clearPreview();return restored.name;});assert.equal(names,'ordered-19');const memory=await host.evaluate(async()=>{const {loopMemory}=await import('./loop-cache.js');return loopMemory();});assert.equal(memory.reserved,0);return {newest:names,memory};
 });
 await check('GPU loss latches HOLD once and reports to the operator',async()=>{
  await load(base([{...cue(0,'loop'),mediaId:media[3].id,in:0,out:4}]));await page.evaluate(()=>window.playerDiagnostics.go());
  await host.evaluate(()=>window.playbackEngine.pgm.gl.getExtension('WEBGL_lose_context').loseContext());await page.waitForFunction(()=>document.getElementById('programState').textContent==='HOLD / ERROR',null,{timeout:5000});await host.waitForTimeout(200);
  assert.equal(await host.evaluate(()=>window.playbackEngine.active[0].playing),false);const errors=result.errors.filter(e=>e.includes('GPU 컨텍스트'));assert.equal(errors.length,1);return {errors:errors.length,held:true};
 });
 const unexpected=result.errors.filter(e=>!e.includes('GPU 컨텍스트'));assert.deepEqual(unexpected,[]);result.passed=true;
}catch(e){result.failure={message:e.message,stack:e.stack};throw e;}finally{await fs.writeFile(path.join(out,'functional-results.json'),JSON.stringify(result,null,2));await app.close();}
