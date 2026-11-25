import {_electron as electron} from 'playwright';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const out=path.resolve(process.env.TEST_OUT||'../diagnostic-v05');await fs.mkdir(out,{recursive:true});
const args=[`--user-data-dir=${path.resolve('../../work/preview-v05-profile')}`];
const app=await electron.launch({...process.env.HARD_EXE?{executablePath:path.resolve(process.env.HARD_EXE),args}:{args:[process.cwd(),...args]},env:{...process.env,PLAYER_TEST:'1'}});
const result={date:new Date().toISOString(),checks:[],errors:[]};let page,host;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await app.firstWindow();for(let i=0;i<100&&!page;i++){page=app.windows().find(p=>p.url().startsWith('player://app/'));if(!page)await sleep(100);}await page.waitForFunction(()=>!!window.playerDiagnostics);
 host=app.windows().find(p=>p.url().endsWith('/render-host.html'));
 for(const p of [page,host])p.on('pageerror',e=>result.errors.push(e.message));
 const [media]=await page.evaluate(paths=>window.native.importPaths(paths),[path.resolve('../youtube-test/media/bunny-youtube.mp4')]);
 await page.evaluate(async media=>{await window.playerDiagnostics.loadProject({schema:'raon-player/1',name:'미리보기 부하 회귀 검사',media:[media],cues:[{id:'preview',name:'실영상',mediaId:media.id,layer:0,in:.5,out:15,mode:'once',auto:false}],layers:Array.from({length:4},()=>({enabled:true,opacity:1,mute:true,fit:'contain',scale:1,x:0,y:0})),output:{width:1920,height:1080,fps:60},views:Array(10).fill('pgm')});await window.playerDiagnostics.go();},media);
 await host.waitForFunction(()=>window.previewDiagnostics.sent>2);
 const freeze=page.evaluate(()=>{const end=performance.now()+2500;while(performance.now()<end){}});
 await sleep(600);const before=await host.evaluate(()=>({...window.previewDiagnostics,time:window.playbackEngine.active[0].time}));
 await sleep(1000);const during=await host.evaluate(()=>({...window.previewDiagnostics,time:window.playbackEngine.active[0].time}));
 assert.equal(before.waiting,1);assert.equal(during.captured,before.captured);assert.equal(during.sent,before.sent);assert.ok(during.time-before.time>.8);await freeze;
 await host.waitForFunction(count=>window.previewDiagnostics.sent>count,during.sent);result.checks.push({name:'Operator freeze stops thumbnail production while real video continues; ACK resumes',before,during});
 await page.evaluate(()=>window.playerDiagnostics.getEngine().hold());await sleep(600);
 const staticBefore=await host.evaluate(()=>({...window.previewDiagnostics}));await sleep(600);const staticAfter=await host.evaluate(()=>({...window.previewDiagnostics}));assert.equal(staticAfter.captured,staticBefore.captured);result.checks.push({name:'Unchanged PGM/PVW are not recaptured or encoded',staticBefore,staticAfter});
 const preview=await page.evaluate(()=>{const c=window.playerDiagnostics.getEngine().pgm.canvas,ctx=c.getContext('2d');const p=ctx.getImageData(0,0,c.width,c.height).data;let peak=0;for(let i=0;i<p.length;i+=4)peak=Math.max(peak,p[i],p[i+1],p[i+2]);return peak;});assert.ok(preview>8);assert.equal(staticAfter.errors,0);assert.deepEqual(result.errors,[]);result.checks.push({name:'Worker JPEG renders actual footage in operator preview',peak:preview});result.passed=true;
}catch(e){result.failure=e.stack;throw e;}finally{const t=Date.now();await app.close();result.shutdownMs=Date.now()-t;await fs.writeFile(path.join(out,'preview-pipeline.json'),JSON.stringify(result,null,2));}
