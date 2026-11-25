import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('../youtube-test');
const app=await electron.launch({executablePath:path.resolve('../player-windows/RaonLocalPlayer-win32-x64/RaonLocalPlayer.exe'),args:[`--user-data-dir=${path.resolve('../../work/youtube-tests/baseline-profile')}`]});
try {
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.playerDiagnostics);
 await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
 const state=JSON.parse(await fs.readFile(path.join(out,'실사_4알파_테스트.lmp'),'utf8'));
 const media=await page.evaluate(p=>window.native.importPaths(p),state.media.map(m=>path.resolve(out,m.path)));
 const ids=new Map(state.media.map((m,i)=>[m.id,media[i].id]));state.media=media;state.cues.forEach(c=>c.mediaId=ids.get(c.mediaId));
 await page.evaluate(s=>window.playerDiagnostics.loadProject(s),state);for(let i=0;i<4;i++)await page.evaluate(()=>window.playerDiagnostics.go());
 for(const source of ['pgm','multiview']){const pending=app.waitForEvent('window');await page.evaluate(s=>{window.playerDiagnostics.openOutput(s);return true;},source);await pending;}
 await page.waitForTimeout(2000);
 const measure=()=>{const e=window.playerDiagnostics.getEngine();return {renderFps:window.playerShared.info().fps,layers:e.active.map(d=>{const q=d.element.getVideoPlaybackQuality();return {total:q.totalVideoFrames,dropped:q.droppedVideoFrames};})};};
 const before=await page.evaluate(measure),samples=[];
 for(let i=0;i<6;i++){await page.waitForTimeout(5000);samples.push(await page.evaluate(measure));}
 const after=samples.at(-1),result={date:new Date().toISOString(),durationSeconds:30,recording:false,screenshotsDuringMeasurement:false,softwareOutputWindows:['PGM','10-slot multiview'],before,after,samples,deltas:after.layers.map((q,i)=>({total:q.total-before.layers[i].total,dropped:q.dropped-before.layers[i].dropped}))};
 await fs.writeFile(path.join(out,'baseline-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await app.close();}
