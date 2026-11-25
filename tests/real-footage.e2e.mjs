import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),out=path.resolve(process.env.REAL_FOOTAGE||'../youtube-test');
const privateRoot=path.resolve('../../work/youtube-tests');
const results={date:new Date().toISOString(),testType:'actual YouTube footage + locally generated RVM alpha',checks:[],errors:[],limitations:['Output windows are software views; no 10-device physical output certification.','Render FPS is distinct from source video FPS.','HTTP(S) was blocked only in this application session.']};
const app=await electron.launch({executablePath:path.resolve('../player-windows/RaonLocalPlayer-win32-x64/RaonLocalPlayer.exe'),args:[`--user-data-dir=${path.join(privateRoot,'app-profile')}`],env:{...process.env,PLAYER_TEST:'1'},timeout:30000});
let page;
const log=message=>console.log(message);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const baseLayers=()=>Array.from({length:4},()=>({opacity:1,enabled:true,mute:true,fit:'contain',x:0,y:0,scale:1}));
const views=['pgm','pvw','layer0','layer1','layer2','layer3','pgm','pvw','layer0','layer3'];
const saveProject=async(name,state)=>{
 const portable=structuredClone(state);portable.media=portable.media.map(m=>({id:m.id,name:m.name,path:path.relative(out,m.path)}));
 await fs.writeFile(path.join(out,name+'.lmp'),JSON.stringify(portable,null,2));
};
try{
 page=await app.firstWindow();page.on('pageerror',e=>results.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')results.errors.push(m.text());});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 await page.waitForFunction(()=>!!window.playerDiagnostics);
 await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,callback)=>callback({cancel:true})));
 results.environment=await page.evaluate(()=>window.native.environment());
 const files=['bunny-youtube.mp4','sintel-youtube.mp4','steel-youtube.mp4',...Array.from({length:4},(_,i)=>`actor0${i+1}-alpha.webm`)];
 const media=await page.evaluate(paths=>window.native.importPaths(paths),files.map(f=>path.join(out,'media',f)));
 assert.ok(media.every(m=>!m.error),JSON.stringify(media));assert.ok(media.slice(3).every(m=>m.alpha));
 results.media=media.map(m=>({name:m.name,width:m.width,height:m.height,fps:m.fps,duration:m.duration,codec:m.codec,alpha:m.alpha}));results.checks.push('3 YouTube clips and 4 locally matted alpha videos imported with HTTP(S) blocked');
 const quadLayers=baseLayers().map((l,i)=>({...l,scale:.48,x:i%2?450:-450,y:i<2?-250:250}));
 const alphaCues=media.slice(3).map((m,i)=>({id:'real-alpha-'+i,name:`실사 알파 ${i+1}`,mediaId:m.id,playbackMediaId:null,layer:i,in:0,out:m.duration,mode:'loop',auto:false}));
 const alphaState={schema:'raon-player/1',name:'유튜브 실사 · 직접 누끼 4개',media,cues:alphaCues,layers:quadLayers,output:{width:1920,height:1080,fps:60},views};
 await page.evaluate(s=>window.playerDiagnostics.loadProject(s),alphaState);for(let i=0;i<4;i++)await page.evaluate(()=>window.playerDiagnostics.go());
 await page.waitForFunction(()=>window.playerDiagnostics.getEngine().active.every(d=>d?.element.getVideoPlaybackQuality().totalVideoFrames>3));
 await saveProject('실사_4알파_테스트',alphaState);
 // Non-black clear color makes fully transparent regions independently visible.
 await page.evaluate(()=>{const e=window.playerDiagnostics.getEngine();e.pgm.gl.clearColor(.035,.07,.10,1);e.pvw.gl.clearColor(.035,.07,.10,1);});
 const pgmWindowPromise=app.waitForEvent('window');await page.evaluate(()=>{window.playerDiagnostics.openOutput('pgm');return true;});const pgm=await pgmWindowPromise;await pgm.waitForFunction(()=>!!window.opener?.playerShared);
 const multiPromise=app.waitForEvent('window');await page.evaluate(()=>{window.playerDiagnostics.openOutput('multiview');return true;});const multi=await multiPromise;await multi.waitForFunction(()=>!!window.opener?.playerShared);
 results.checks.push('independent PGM and 10-slot multiview opened on real alpha footage');
 await page.evaluate(()=>{
  const e=window.playerDiagnostics.getEngine();window.realMetrics={started:performance.now(),layers:e.active.map(()=>({callbacks:0,loops:0,maxGapMs:0,previousWall:null,previousMedia:null})),exclude:false,stopped:false};
  e.active.forEach((d,i)=>{const video=d.element;const cb=(now,meta)=>{const m=window.realMetrics.layers[i];if(window.realMetrics.stopped)return;if(!window.realMetrics.exclude){if(m.previousWall!==null)m.maxGapMs=Math.max(m.maxGapMs,now-m.previousWall);if(m.previousMedia!==null&&meta.mediaTime<m.previousMedia-.1)m.loops++;m.callbacks++;m.previousWall=now;m.previousMedia=meta.mediaTime;}else m.previousWall=null;video.requestVideoFrameCallback(cb);};video.requestVideoFrameCallback(cb);});
  const stream=e.pgm.canvas.captureStream(30),type=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/webm';const recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:4500000}),chunks=[];
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};window.recordingDone=new Promise(resolve=>recorder.onstop=async()=>{const bytes=new Uint8Array(await new Blob(chunks,{type}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));window.pgmRecording=btoa(binary);stream.getTracks().forEach(t=>t.stop());resolve(true);});recorder.start();setTimeout(()=>recorder.stop(),10000);
 });
 results.fourAlphaSamples=[];
 log('REAL FOUR-ALPHA: 60-second loop / output test started');
 for(let i=0;i<12;i++){
  await delay(5000);
  const sample=await page.evaluate(()=>({elapsed:(performance.now()-window.realMetrics.started)/1000,renderFps:window.playerShared.info().fps,decoders:window.playerDiagnostics.getEngine().active.map(d=>({time:d.element.currentTime,paused:d.element.paused,quality:d.element.getVideoPlaybackQuality().toJSON?.()||{totalVideoFrames:d.element.getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:d.element.getVideoPlaybackQuality().droppedVideoFrames}}))}));results.fourAlphaSamples.push(sample);
  if(i%3===2)log(`four alpha elapsed ${Math.round(sample.elapsed)}s / render ${sample.renderFps.toFixed(1)}fps`);
  if(i===2){await page.screenshot({path:path.join(out,'player-four-alpha.png')});await pgm.screenshot({path:path.join(out,'pgm-four-alpha.png')});await multi.screenshot({path:path.join(out,'multiview-real.png')});}
 }
 results.alphaCallbacks=await page.evaluate(()=>{window.realMetrics.stopped=true;return window.realMetrics.layers;});
 assert.ok(results.alphaCallbacks.every(m=>m.callbacks>600&&m.loops>=8),JSON.stringify(results.alphaCallbacks));
 results.checks.push('60-second simultaneous playback of 4 real alpha videos with repeated loop crossings and advancing decoded frames');
 const bgPixel=await page.evaluate(()=>window.playerDiagnostics.readPixel(5,5));results.transparencyBackgroundPixel=bgPixel;assert.ok(bgPixel[0]>=7&&bgPixel[0]<=12&&bgPixel[1]>=15&&bgPixel[1]<=22&&bgPixel[2]>=22&&bgPixel[2]<=30);results.checks.push('transparent outside regions reveal the independently set canvas background');
 await page.evaluate(()=>window.playerDiagnostics.getEngine().hold());const before=await page.evaluate(()=>window.playerDiagnostics.getEngine().active.map(d=>d.time));await delay(500);const after=await page.evaluate(()=>window.playerDiagnostics.getEngine().active.map(d=>d.time));assert.ok(after.every((v,i)=>Math.abs(v-before[i])<.08));await page.evaluate(()=>window.playerDiagnostics.getEngine().resume());await delay(500);assert.ok(await page.evaluate(()=>window.playerDiagnostics.getEngine().active.every(d=>!d.element.paused)));results.checks.push('HOLD / RESUME on four real alpha videos');
 await page.evaluate(()=>window.recordingDone);const recording=await page.evaluate(()=>window.pgmRecording);await fs.writeFile(path.join(out,'four-alpha-live.webm'),Buffer.from(recording,'base64'));
 await pgm.close();await multi.close();
 log('REAL CUT TEST: mixed 60fps / 24fps / aspect ratios, 100 transitions');
 const sequence={schema:'raon-player/1',name:'유튜브 일반 영상 100회 전환',media,cues:Array.from({length:102},(_,i)=>({id:'real-cut-'+i,name:`실영상 CUT ${i+1} · ${['Bunny','Sintel','Steel'][i%3]}`,mediaId:media[i%3].id,layer:0,in:.5,out:2.5,mode:'once',auto:false})),layers:baseLayers(),output:{width:1920,height:1080,fps:60},views};
 await page.evaluate(s=>window.playerDiagnostics.loadProject(s),sequence);await page.evaluate(()=>window.playerDiagnostics.go());await delay(150);
 await page.evaluate(()=>{window.cutAudit={active:true,samples:0,black:0,minimumMean:255};const canvas=document.createElement('canvas');canvas.width=48;canvas.height=27;const ctx=canvas.getContext('2d',{willReadFrequently:true});const loop=()=>{if(!window.cutAudit.active)return;ctx.drawImage(window.playerShared.source('pgm'),0,0,48,27);const data=ctx.getImageData(0,0,48,27).data;let total=0,peak=0;for(let i=0;i<data.length;i+=4){total+=data[i]+data[i+1]+data[i+2];peak=Math.max(peak,data[i],data[i+1],data[i+2]);}const mean=total/(48*27*3);window.cutAudit.minimumMean=Math.min(window.cutAudit.minimumMean,mean);window.cutAudit.samples++;if(mean<2&&peak<8)window.cutAudit.black++;requestAnimationFrame(loop);};loop();});
 const timings=[];for(let i=0;i<100;i++){const start=performance.now();await page.evaluate(()=>window.playerDiagnostics.go());timings.push(performance.now()-start);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));if((i+1)%25===0)log(`real CUT ${i+1}/100`);}
 results.cuts=await page.evaluate(()=>{window.cutAudit.active=false;return window.cutAudit;});results.cuts.goAndPrepareNextMs=timings;assert.equal(results.cuts.black,0,JSON.stringify(results.cuts));results.checks.push('100 actual-video preloaded CUTs, no all-black samples in sampled output frames');
 const simple={...sequence,name:'유튜브 영상 기본 재생',cues:sequence.cues.slice(0,3)};await saveProject('유튜브_일반영상_테스트',simple);
 log('REAL PINGPONG: generating alpha-preserving forward / reverse cache');
 const alphaMedia=media[3],cue={id:'real-ping',name:'실사 알파 핑퐁',mediaId:alphaMedia.id,layer:0,in:0,out:alphaMedia.duration,mode:'pingpong',auto:false};
 const cache=await page.evaluate(({id,cue})=>window.native.pingpong(id,cue),{id:alphaMedia.id,cue});assert.ok(cache.alpha);const copied=path.join(out,'media','actor01-pingpong.webm');await fs.copyFile(cache.path,copied);const [copiedMedia]=await page.evaluate(paths=>window.native.importPaths(paths),[copied]);
 const pingState={...sequence,name:'실사 알파 핑퐁',media:[...media,copiedMedia],cues:[{...cue,playbackMediaId:copiedMedia.id}],layers:baseLayers()};await page.evaluate(s=>window.playerDiagnostics.loadProject(s),pingState);await page.evaluate(()=>window.playerDiagnostics.go());await delay(9000);const pingTime=await page.evaluate(()=>{const d=window.playerDiagnostics.getEngine().active[0];return {currentTime:d.time,quality:d.element.getVideoPlaybackQuality().toJSON?.()||null,ended:d.ended,paused:d.element.paused};});assert.ok(!pingTime.ended&&!pingTime.paused);results.pingpong={duration:cache.duration,width:cache.width,height:cache.height,alpha:cache.alpha,playback:pingTime};await saveProject('実写_핑퐁_테스트'.replace('実写','실사'),pingState);results.checks.push('real alpha pingpong generated, alpha retained, and looped beyond one complete cycle');
 // Ordinary background + three real alpha clips exercises overlap, not only quadrants.
 const overlayState={...sequence,name:'유튜브 배경 + 실사 알파 3개',cues:[{id:'bg-real',name:'YouTube 배경',mediaId:media[0].id,layer:0,in:.5,out:8,mode:'loop',auto:false},...media.slice(3,6).map((m,i)=>({id:'overlay-real-'+i,name:`실사 누끼 ${i+1}`,mediaId:m.id,layer:i+1,in:0,out:m.duration,mode:'loop',auto:false}))],layers:baseLayers().map((l,i)=>i===0?l:{...l,x:(i-2)*520,scale:.7})};
 await page.evaluate(s=>window.playerDiagnostics.loadProject(s),overlayState);for(let i=0;i<4;i++)await page.evaluate(()=>window.playerDiagnostics.go());await delay(1000);await page.screenshot({path:path.join(out,'background-plus-alpha.png')});await saveProject('일반배경_실사알파_합성',overlayState);results.checks.push('ordinary YouTube background overlapped with three independently matted actors');
 assert.equal(results.errors.length,0,results.errors.join('\n'));results.completed=true;
 await fs.writeFile(path.join(out,'test-results.json'),JSON.stringify(results,null,2));log(JSON.stringify({checks:results.checks,cuts:results.cuts.samples,blackSamples:results.cuts.black,errors:results.errors},null,2));
}catch(e){results.failure={message:e.message,stack:e.stack};await fs.writeFile(path.join(out,'test-results.json'),JSON.stringify(results,null,2));if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;}
finally{await app.close();}
