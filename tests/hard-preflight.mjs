import {_electron as electron} from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
const app=await electron.launch({args:[process.cwd(),`--user-data-dir=${path.resolve('../../work/hard-tests/preflight')}`],env:{...process.env,PLAYER_TEST:'1'}});
try{
 const p=await app.firstWindow();await p.waitForFunction(()=>!!window.playerDiagnostics);
 const media=await p.evaluate(a=>window.native.importPaths(a),['alpha0.png','motion.mp4'].map(n=>path.resolve('tests/fixtures',n)));
 const result=await p.evaluate(async media=>{
  const {Deck}=await import('./engine.js'),{loopMemory}=await import('./loop-cache.js');const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const image=new Deck(media[0],{id:'image',in:1,out:1.2,mode:'loop',layer:0});await image.load();await image.play();await wait(350);image.tick(performance.now());const imageTime=image.time;image.dispose();
  const d=new Deck(media[1],{id:'race',in:0,out:1,mode:'loop',layer:0});await d.load();await d.play();d.pause();const pending=d.play();d.pause();await pending;const racePlaying=d.playing;d.dispose();
  const e=window.playerDiagnostics.getEngine();e.resize({width:640,height:360,fps:30});await e.prepare({id:'fps',in:0,out:1,mode:'loop',layer:0},media[1]);const loopFps=e.prepared.cache.fps;e.clearPreview();
  return {imageTime,expectedImageRange:[1,1.2],racePlaying,expectedRacePlaying:false,loopFps,outputFps:30,memory:loopMemory()};
 },media);
 const out=path.resolve('../../work/hard-tests');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'preflight.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await app.close();}
