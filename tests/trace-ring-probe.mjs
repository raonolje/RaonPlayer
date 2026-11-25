import {_electron as electron} from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
const out=path.resolve('../soak-20261023/trace-ring-probe');await fs.mkdir(out,{recursive:true});
const app=await electron.launch({executablePath:path.resolve('../player-windows-v0.7/RaonLocalPlayer-win32-x64/RaonLocalPlayer.exe'),args:[`--user-data-dir=${path.resolve('../../work/trace-ring-probe-profile')}`],env:{...process.env,PLAYER_TEST:'1'}});
try{
 const page=await app.firstWindow();await page.waitForLoadState();
 await app.evaluate(({contentTracing})=>contentTracing.startRecording({included_categories:['toplevel','devtools.timeline','disabled-by-default-devtools.timeline','blink.console'],record_mode:'record-continuously',trace_buffer_size_in_kb:1024}));
 const start=performance.now();
 await page.evaluate(async()=>{console.timeStamp('RAON_PROBE_BEGIN');for(let j=0;j<240;j++){await new Promise(r=>setTimeout(r,50));for(let i=0;i<250;i++)console.timeStamp('RAON_FILL_'+j+'_'+i);}console.timeStamp('RAON_PROBE_END');});
 const trace=path.join(out,'ring.pftrace');await app.evaluate(({contentTracing},p)=>contentTracing.stopRecording(p),trace);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({elapsedMs:performance.now()-start,trace},null,2));console.log(trace);
}finally{await app.close();}
