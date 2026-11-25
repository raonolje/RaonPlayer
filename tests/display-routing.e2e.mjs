import {_electron as electron} from 'playwright';import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const app=await electron.launch({executablePath:path.resolve(process.env.HARD_EXE||'../player-windows-v0.5/RaonLocalPlayer-win32-x64/RaonLocalPlayer.exe'),args:[`--user-data-dir=${path.resolve('../../work/hard-tests/routing-profile')}`],env:{...process.env,PLAYER_TEST:'1'}});

async function outputPage(id){for(let i=0;i<100;i++){const p=app.windows().find(p=>{try{return new URL(p.url()).searchParams.get('id')===id;}catch{return false;}});if(p)return p;await new Promise(r=>setTimeout(r,20));}throw new Error('Output page missing: '+id);}
try{
 await app.firstWindow();let p;for(let i=0;i<100&&!p;i++){p=app.windows().find(p=>p.url().startsWith('player://app/'));if(!p)await new Promise(r=>setTimeout(r,100));}await p.waitForFunction(()=>!!window.playerDiagnostics,null,{timeout:30000});const env=await p.evaluate(()=>window.native.environment()),result={date:new Date().toISOString(),checks:[],note:'Native window placement only, not physical signal synchronization or 10-device throughput.'};await p.locator('#showOutputs').click();
 for(const display of env.displays){
  await p.locator('#displaySelect').selectOption(String(display.id));const {id:windowId}=await p.evaluate(()=>window.playerDiagnostics.openOutput('pgm'));const page=await outputPage(windowId);await page.waitForFunction(()=>!!window.opener?.playerShared);const id=new URL(page.url()).searchParams.get('id');
  const actual=await app.evaluate(({BrowserWindow,screen},id)=>{const w=BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).searchParams.get('id')===id),bounds=w.getBounds();return {bounds,matchedDisplayId:screen.getDisplayMatching(bounds).id};},id);assert.equal(actual.matchedDisplayId,display.id);result.checks.push({requested:display.id,label:display.label,...actual});await p.evaluate(id=>window.playerDiagnostics.getEngine().command('closeOutput',{id}),id);
 }
 result.passed=true;await fs.writeFile(path.resolve((process.env.TEST_OUT||'../diagnostic-v05')+'/display-routing.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await app.close();}
