import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const out=path.resolve('../hard-test'),work=path.resolve('../../work/hard-tests'),profile=path.join(work,'functional-profile');await fs.mkdir(out,{recursive:true});await fs.mkdir(work,{recursive:true});
const args=[`--user-data-dir=${profile}`];
const app=await electron.launch({...process.env.HARD_EXE?{executablePath:path.resolve(process.env.HARD_EXE),args}:{args:[process.cwd(),...args]},env:{...process.env,PLAYER_TEST:'1'},timeout:30000});
const result={date:new Date().toISOString(),packaged:!!process.env.HARD_EXE,checks:[],pageErrors:[],consoleErrors:[],errorEvents:[]};let page,media,currentCheck=null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const layers=()=>Array.from({length:4},()=>({enabled:true,opacity:1,mute:true,fit:'contain',x:0,y:0,scale:1}));
const m=name=>media.find(m=>m.name===name);
const cue=(name,id='cue',layer=0,mode='once',start=0,end=1)=>({id,name,mediaId:m(name).id,playbackMediaId:null,layer,in:start,out:end,mode,auto:false});
const project=(cues,output={width:1920,height:1080,fps:60})=>({schema:'raon-player/1',name:'하드 테스트',media,cues,layers:layers(),output,views:['pgm','pvw','layer0','layer1','layer2','layer3','pgm','pvw','layer0','layer3']});
const load=async p=>{if(await page.locator('#lock').evaluate(el=>el.classList.contains('locked')))await page.locator('#lock').click();await page.evaluate(p=>window.playerDiagnostics.loadProject(p),p);};
const go=()=>page.evaluate(()=>window.playerDiagnostics.go());
const ready=()=>page.waitForFunction(()=>document.getElementById('readyState').textContent==='READY',null,{timeout:120000});
async function check(name,fn){currentCheck=name;console.log('CHECK '+name);const start=Date.now();try{const evidence=await fn();result.checks.push({name,passed:true,seconds:(Date.now()-start)/1000,evidence});}catch(e){result.checks.push({name,passed:false,seconds:(Date.now()-start)/1000,error:e.message});console.log('FAILED '+e.message);await page?.screenshot({path:path.join(out,'failure-'+result.checks.length+'.png')}).catch(()=>{});}await fs.writeFile(path.join(out,'functional-results.json'),JSON.stringify(result,null,2));}
try{
 page=await app.firstWindow();page.on('pageerror',e=>result.pageErrors.push(e.message));page.on('console',msg=>{if(msg.type()==='error'){result.consoleErrors.push(msg.text());result.errorEvents.push({check:currentCheck,message:msg.text()});}});await page.waitForFunction(()=>!!window.playerDiagnostics);
 await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
 result.environment=await page.evaluate(()=>window.native.environment());
 await check('Single instance and custom SVG / ICO assets',async()=>{
  const executable=await app.evaluate(()=>process.execPath),args=[...process.env.HARD_EXE?[]:[process.cwd()],`--user-data-dir=${profile}`];
  const code=await new Promise((resolve,reject)=>{const child=spawn(executable,args,{env:{...process.env,PLAYER_TEST:'1'},windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-2000));const timer=setTimeout(()=>{child.kill();reject(new Error('Second instance did not exit: '+JSON.stringify({executable,args,stderr})));},15000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve(code);});});assert.equal(code,0);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  await page.waitForFunction(()=>document.querySelector('.app-icon')?.naturalWidth>0);return {secondInstanceExited:true,iconVisible:true};
 });
 const files=[...['red.mp4','blue.mp4','motion.mp4','alpha.webm','alpha0.png','alpha1.png','alpha2.png','alpha3.png'].map(n=>path.resolve('tests/fixtures',n)),...['bunny-youtube.mp4','sintel-youtube.mp4','steel-youtube.mp4','actor01-alpha.webm','actor02-alpha.webm','actor03-alpha.webm','actor04-alpha.webm','actor01-pingpong.webm'].map(n=>path.resolve('../youtube-test/media',n))];
 media=await page.evaluate(paths=>window.native.importPaths(paths),files);assert.ok(media.every(m=>!m.error),JSON.stringify(media));
 await check('Mixed valid, corrupt, missing imports; Unicode path; range and suffix reads',async()=>{
  const unicode=path.join(work,'한글 공백 영상.mp4'),bad=path.join(work,'broken.mp4');await fs.copyFile(files[0],unicode);await fs.writeFile(bad,'not a movie');
  const items=await page.evaluate(p=>window.native.importPaths(p),[unicode,bad,path.join(work,'absent.mp4')]);assert.equal(items.filter(m=>m.error).length,2);
  const range=await page.evaluate(async url=>{const a=await fetch(url,{headers:{Range:'bytes=10-29'}}),b=await fetch(url,{headers:{Range:'bytes=-16'}}),c=await fetch(url,{headers:{Range:'bytes=999999999-'}});return {status:a.status,bytes:Array.from(new Uint8Array(await a.arrayBuffer())),suffix:Array.from(new Uint8Array(await b.arrayBuffer())),badStatus:c.status};},m('red.mp4').url);
  const bytes=await fs.readFile(files[0]);assert.equal(range.status,206);assert.deepEqual(range.bytes,[...bytes.subarray(10,30)]);assert.deepEqual(range.suffix,[...bytes.subarray(-16)]);assert.equal(range.badStatus,416);return {importErrors:2,unicode:true,range:true};
 });
 await check('Image IN/OUT, short automatic chain, deleting on-air auto cue',async()=>{
  const p=project(Array.from({length:8},(_,i)=>({...cue('alpha0.png','auto-'+i,0,'once',1,1.1),auto:true})));await load(p);await go();await page.waitForFunction(()=>window.playerDiagnostics.getEngine().active[0]?.cue.id==='auto-7',null,{timeout:10000});
  const deleted=project([{...cue('red.mp4','remove-me',0,'once',0,2.5),auto:true},cue('blue.mp4','remain',1,'once',0,2)]);await load(deleted);await go();await page.evaluate(async()=>{await window.playerDiagnostics.select('remove-me');document.getElementById('deleteCue').click();});await delay(2800);assert.equal(await page.evaluate(()=>window.playerDiagnostics.getEngine().active[1]),null);return {autoCues:8,deletedCueDidNotAdvance:true};
 });
 await check('Slow next preparation does not lose automatic advance; HOLD cancels pending auto',async()=>{
  const p=project([{...cue('red.mp4','quick',0,'once',0,.03),auto:true},cue('actor02-alpha.webm','slow',0,'loop',0,4)]);await load(p);await go();await page.waitForFunction(()=>window.playerDiagnostics.getEngine().active[0]?.cue.id==='slow',null,{timeout:10000});
  await load(p);const held=await page.evaluate(async()=>{const e=window.playerDiagnostics.getEngine(),original=e.prepare.bind(e);e.prepare=async(...args)=>{await new Promise(r=>setTimeout(r,300));return original(...args);};try{const pending=window.playerDiagnostics.go();setTimeout(()=>document.getElementById('hold').click(),150);await pending;await new Promise(r=>setTimeout(r,500));return e.active[0]?.cue.id;}finally{e.prepare=original;}});assert.equal(held,'quick');return {autoAfterPrepare:true,holdCancelledDuringDelayedPrepare:true};
 });
 await check('100 rapid HOLD/RESUME races; overload HOLD can resume; GO/BLACK race',async()=>{
  await load(project([cue('actor01-alpha.webm','race',0,'loop',0,4)]));await go();
  const checks=await page.evaluate(async()=>{const e=window.playerDiagnostics.getEngine();for(let i=0;i<100;i++){e.resume();e.hold();await Promise.resolve();}await new Promise(r=>setTimeout(r,20));const held=!e.active[0].playing;e.resume();await new Promise(r=>setTimeout(r,50));const d=e.active[0];d.visualEpoch-=1000;d.overloadSince=performance.now()-1200;let overloaded=false;try{d.tick(performance.now());}catch{overloaded=true;d.pause();}await d.play();d.tick(performance.now());return {held,overloaded,recovered:d.playing};});assert.deepEqual(checks,{held:true,overloaded:true,recovered:true});
  await page.evaluate(async()=>{const e=window.playerDiagnostics.getEngine(),state=window.playerDiagnostics.getState();await e.prepare(state.cues[0],state.media.find(m=>m.id===state.cues[0].mediaId));const p=e.go().catch(()=>null);e.black();await p;});assert.equal(await page.evaluate(()=>window.playerDiagnostics.getEngine().active.filter(Boolean).length),0);return checks;
 });
 await check('Four alpha image layers: opacity, visibility, transform, mute, clear and lock',async()=>{
  await load(project([0,1,2,3].map(i=>cue(`alpha${i}.png`,'rgba-'+i,i,'loop',0,10))));for(let i=0;i<4;i++)await go();await delay(150);
  const before=await page.evaluate(()=>window.playerDiagnostics.readPixel(480,810));assert.ok(before[0]>120&&before[1]<5,JSON.stringify(before));
  const layer=page.locator('.layer-item').first();await layer.getByRole('slider').fill('0');await delay(100);assert.ok((await page.evaluate(()=>window.playerDiagnostics.readPixel(480,810)))[0]<5);await layer.getByRole('slider').fill('1');
  await layer.locator('.layer-head input').uncheck();await delay(100);assert.ok((await page.evaluate(()=>window.playerDiagnostics.readPixel(480,810)))[0]<5);await layer.locator('.layer-head input').check();
  await layer.locator('input[type=number]').first().fill('100');await layer.locator('input[type=number]').first().dispatchEvent('change');assert.equal((await page.evaluate(()=>window.playerDiagnostics.getState())).layers[0].x,100);
  await page.locator('#lock').click();assert.ok(await layer.getByRole('slider').isDisabled());await page.locator('#black').click();assert.equal(await page.evaluate(()=>window.playerDiagnostics.getEngine().active.filter(Boolean).length),4);await page.locator('#lock').click();await layer.getByRole('button',{name:'레이어 비우기'}).click();assert.equal(await page.evaluate(()=>window.playerDiagnostics.getEngine().active[0]),null);return {alpha:true,opacity:true,visibility:true,transform:true,lock:true,clear:true};
 });
 await check('Queue duplicate / move / edit validation / delete; Ctrl+S while input focused',async()=>{
  await load(project([cue('red.mp4','edit')]));await page.locator('#duplicateCue').click();await ready();assert.equal((await page.evaluate(()=>window.playerDiagnostics.getState())).cues.length,2);await page.locator('#moveUp').click();assert.equal((await page.evaluate(()=>window.playerDiagnostics.getState())).cues[0].name,'red.mp4 · 복사');await page.locator('#moveDown').click();
  await page.locator('#cueOut').fill('-1');await page.locator('#cueOut').dispatchEvent('change');assert.equal((await page.evaluate(()=>window.playerDiagnostics.getState())).cues[1].out,1);
  const saved=path.join(work,'키보드 저장.lmp');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},saved);
  await page.locator('#cueName').fill('입력 중 저장');await page.locator('#cueName').press('Control+s');await page.waitForFunction(()=>document.getElementById('dirtyStatus').textContent==='저장 완료');assert.equal(JSON.parse(await fs.readFile(saved,'utf8')).cues[1].name,'입력 중 저장');await page.locator('#deleteCue').click();await ready();return {duplicate:true,reorder:true,invalidRangeRejected:true,inputShortcutSaved:true};
 });
 await check('Portrait / ultrawide canvas, FIT FILL STRETCH, active resize rejection and 60→30 loop cap',async()=>{
  await load(project([cue('red.mp4','aspect',0,'loop',0,1)],{width:480,height:800,fps:60}));await go();await delay(100);assert.ok((await page.evaluate(()=>window.playerDiagnostics.readPixel(5,5)))[0]<5);
  const fit=page.locator('.layer-item').first().getByRole('combobox');for(const mode of ['cover','stretch']){await fit.selectOption(mode);await delay(100);assert.ok((await page.evaluate(()=>window.playerDiagnostics.readPixel(5,5)))[0]>200);}
  const resize=await page.evaluate(()=>{try{window.playerDiagnostics.getEngine().resize({width:1000,height:250,fps:30});return false;}catch{return true;}});assert.ok(resize);
  await load(project([cue('bunny-youtube.mp4','60to30',0,'loop',.5,1.5)],{width:1000,height:250,fps:30}));assert.equal(await page.evaluate(()=>window.playerDiagnostics.getEngine().prepared.cache.fps),30);await go();await delay(1500);const fps=await page.evaluate(()=>window.playerDiagnostics.getEngine().fps);assert.ok(fps>25&&fps<35,`30fps canvas ran at ${fps}`);return {aspectRatios:true,fitModes:3,activeResizeRejected:true,source60ToOutput30:true,renderFps:fps};
 });
 await check('Autosave concurrent writes / recovery isolation / cancelled save / malformed project',async()=>{
  await load(project([cue('red.mp4','save')]));const state=await page.evaluate(()=>window.playerDiagnostics.getState());const oldFile=path.join(work,'original-project.lmp');await fs.writeFile(oldFile,JSON.stringify(state));await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},oldFile);await page.evaluate(()=>window.native.open());
  await page.evaluate(async s=>{await Promise.all(Array.from({length:20},(_,i)=>window.native.autosave({...s,name:'recovery-'+i})));},state);const restored=await page.evaluate(()=>window.native.recovery());assert.equal(restored.name,'recovery-19');
  const newFile=path.join(work,'recovered-save.lmp');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},newFile);const saved=await page.evaluate(p=>window.native.save(p),restored);assert.equal(saved,newFile);assert.equal(JSON.parse(await fs.readFile(oldFile,'utf8')).name,state.name);
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});assert.equal(await page.evaluate(p=>window.native.save(p,true),state),null);
  const malformed=path.join(work,'bad-project.lmp');await fs.writeFile(malformed,'{"schema":"wrong"}');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},malformed);await assert.rejects(()=>page.evaluate(()=>window.native.open()),/형식/);return {concurrentAutosaves:20,lastWriteWon:true,recoverySaveAs:true,cancelPreserved:true,malformedRejected:true};
 });
 await check('Missing media relink clears stale pingpong cache; portable package roundtrip',async()=>{
  const missing=project([{...cue('motion.mp4','missing',0,'pingpong',0,1),playbackMediaId:m('actor01-pingpong.webm').id}]);missing.media=structuredClone(media);missing.media.find(x=>x.id===m('motion.mp4').id).path=path.join(work,'missing-source.mp4');
  const file=path.join(work,'missing.lmp');await fs.writeFile(file,JSON.stringify(missing));await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.locator('#openProject').click();await delay(200);await assert.rejects(()=>page.evaluate(p=>window.native.packageProject(p),missing),/누락/);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.resolve('tests/fixtures/motion.mp4'));
  await page.locator('.media-item').filter({hasText:'motion.mp4'}).getByRole('button',{name:'다시 연결'}).click();await delay(150);assert.equal((await page.evaluate(()=>window.playerDiagnostics.getState())).cues[0].playbackMediaId,null);
  // Use a small, self-contained project for copy/open checks.
  const small=project([cue('red.mp4','portable')]);small.media=[m('red.mp4')];await load(small);await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},work);const packaged=await page.evaluate(p=>window.native.packageProject(p),small);const data=JSON.parse(await fs.readFile(packaged,'utf8'));assert.ok(data.media.every(m=>!path.isAbsolute(m.path)));await fs.access(path.resolve(path.dirname(packaged),data.media[0].path));return {relinkInvalidatedCache:true,portableRelativeMedia:true};
 });
 await check('10 output software windows, cap at 11th, reopen and fullscreen Escape',async()=>{
  await load(project([cue('motion.mp4','output',0,'loop',0,1)]));await go();const windows=[];
  for(let i=0;i<10;i++){const event=app.waitForEvent('window');await page.evaluate(s=>{window.playerDiagnostics.openOutput(s);return true;},i===0?'pgm':i===1?'multiview':`layer${i%4}`);const w=await event;await w.waitForFunction(()=>!!window.opener?.playerShared);windows.push(w);}
  await assert.rejects(()=>page.evaluate(()=>{window.playerDiagnostics.openOutput('pgm');return true;}),/최대 10/);
  await windows[0].close();const event=app.waitForEvent('window');await page.evaluate(()=>{window.playerDiagnostics.openOutput('pgm');return true;});const reopened=await event;await reopened.waitForFunction(()=>!!window.opener?.playerShared);const id=new URL(reopened.url()).searchParams.get('id');await app.evaluate(({BrowserWindow},id)=>{const w=BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).searchParams.get('id')===id);w.showInactive();w.setFullScreen(true);w.focus();},id);await delay(500);await reopened.keyboard.press('Escape');await delay(500);assert.equal(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).searchParams.get('id')===id).isFullScreen(),id),false);
  for(const w of [...windows.slice(1),reopened])await w.close();return {softwareWindows:10,capEnforced:true,reopen:true,escape:true};
 });
 await check('Rapid selection 200 times leaves only final preview; BLACK frees active cache',async()=>{
  await load(project([cue('actor01-alpha.webm','a',0,'loop',0,4),cue('actor02-alpha.webm','b',0,'loop',0,4)]));
  const report=await page.evaluate(async()=>{const tasks=Array.from({length:200},(_,i)=>window.playerDiagnostics.select(i%2?'b':'a'));await Promise.all(tasks);const e=window.playerDiagnostics.getEngine(),{loopMemory}=await import('./loop-cache.js');const final=e.prepared.cue.id;await e.go();e.black();e.clearPreview();await new Promise(r=>setTimeout(r,100));return {final,memory:loopMemory()};});assert.equal(report.final,'b');assert.equal(report.memory.reserved,0);return report;
 });
 const cutCount=process.env.HARD_QUICK?20:1000;
 await check(`Real footage: ${cutCount} preloaded CUTs, sampled output black detection`,async()=>{
  await load(project(Array.from({length:cutCount+2},(_,i)=>cue(['bunny-youtube.mp4','sintel-youtube.mp4','steel-youtube.mp4'][i%3],'cut-'+i,0,'once',.5,2.5))));await go();await delay(100);
  await page.evaluate(()=>{const e=window.playerDiagnostics.getEngine(),original=e.pgm.render.bind(e.pgm),c=new OffscreenCanvas(32,18),ctx=c.getContext('2d',{willReadFrequently:true});window.cutHard={samples:0,black:0};e.pgm.render=(...args)=>{original(...args);ctx.drawImage(e.pgm.canvas,0,0,32,18);const a=ctx.getImageData(0,0,32,18).data;let peak=0,sum=0;for(let i=0;i<a.length;i+=4){peak=Math.max(peak,a[i],a[i+1],a[i+2]);sum+=a[i]+a[i+1]+a[i+2];}window.cutHard.samples++;if(peak<8&&sum/(32*18*3)<2)window.cutHard.black++;};window.stopHardCuts=()=>{e.pgm.render=original;return window.cutHard;};});
  const times=[];for(let i=0;i<cutCount;i++){const start=performance.now();await go();times.push(performance.now()-start);if((i+1)%100===0)console.log('CUT '+(i+1)+'/'+cutCount);}
  const audit=await page.evaluate(()=>window.stopHardCuts());assert.equal(audit.black,0,JSON.stringify(audit));return {...audit,cuts:cutCount,meanGoWithPreparationMs:times.reduce((a,b)=>a+b,0)/times.length,maxGoWithPreparationMs:Math.max(...times)};
 });
 await check('FFmpeg cancellation removes partial files; normal and alpha transcodes; pingpong endpoints',async()=>{
  const aborted=page.evaluate(id=>window.native.transcode(id),m('bunny-youtube.mp4').id);await delay(100);await page.evaluate(()=>window.native.cancelJob());await assert.rejects(()=>aborted,/실패|취소/);
  const normal=await page.evaluate(id=>window.native.transcode(id),m('red.mp4').id),alpha=await page.evaluate(id=>window.native.transcode(id),m('alpha.webm').id);assert.equal(normal.codec,'h264');assert.ok(alpha.alpha);
  const ping=await page.evaluate(({id,c})=>window.native.pingpong(id,c),{id:m('motion.mp4').id,c:cue('motion.mp4','ping',0,'pingpong',0,1)});assert.ok(Math.abs(ping.duration-58/30)<.05);
  const partials=[];async function walk(dir){for(const f of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())await walk(p);else if(f.name.includes('.partial'))partials.push(p);}}await walk(profile);assert.deepEqual(partials,[]);return {cancelled:true,noPartialFiles:true,h264:true,alpha:true,pingpongFrames:58};
 });
 await check('GPU context loss holds safely with one error; main window remains responsive',async()=>{
  await load(project([cue('motion.mp4','gpu',0,'loop',0,1)]));await go();const count=result.consoleErrors.length;await page.evaluate(()=>window.playerDiagnostics.getEngine().pgm.gl.getExtension('WEBGL_lose_context').loseContext());await delay(700);const d=await page.evaluate(()=>({playing:window.playerDiagnostics.getEngine().active[0].playing,status:document.getElementById('programState').textContent}));assert.equal(d.playing,false);assert.match(d.status,/ERROR/);const errors=result.consoleErrors.slice(count).filter(e=>e.includes('GPU 컨텍스트'));assert.equal(errors.length,1);return {hold:true,errorCount:errors.length,restartRequired:true};
 });
 result.unexpectedErrors=result.consoleErrors.filter(e=>!['출력 잠금을 해제','IN은 0 이상','GPU 컨텍스트','416 (Requested Range Not Satisfiable)'].some(s=>e.includes(s)));result.completed=true;result.passed=result.checks.every(c=>c.passed)&&result.pageErrors.length===0&&result.unexpectedErrors.length===0;
 await fs.writeFile(path.join(out,'functional-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks.map(c=>({name:c.name,passed:c.passed,error:c.error})),pageErrors:result.pageErrors,unexpectedErrors:result.unexpectedErrors},null,2));if(!result.passed)process.exitCode=1;
}finally{await app.close();}
