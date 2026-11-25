import {_electron as electron} from 'playwright';
import path from 'node:path';
const app=await electron.launch({args:[process.cwd(),`--user-data-dir=${path.resolve('../../work/isolation-smoke-profile')}`],env:{...process.env,PLAYER_TEST:'1'},timeout:30000});
try{
 app.on('window',p=>{p.on('pageerror',e=>console.log('ERROR',p.url(),e.message));p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',p.url(),m.text());});});
 await app.firstWindow();let page;for(let i=0;i<100&&!page;i++){page=app.windows().find(p=>p.url().startsWith('player://app/'));if(!page)await new Promise(r=>setTimeout(r,100));}console.log('FIRST',page.url());page.on('pageerror',e=>console.log('ERR',e.message));page.on('console',m=>{if(m.type()==='error')console.log('ERRCONSOLE',m.text());});
 await page.waitForFunction(()=>!!window.playerDiagnostics,{},{timeout:30000});
 console.log('WINDOWS',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),pid:w.webContents.getOSProcessId()}))));
 await page.evaluate(async()=>window.playerDiagnostics.loadProject(await window.native.demo()));
 await page.evaluate(()=>window.playerDiagnostics.go());await page.waitForTimeout(2000);
 console.log('PIXEL',await page.evaluate(()=>window.playerDiagnostics.readPixel(960,540)));
 console.log('STATE',await page.evaluate(()=>{const e=window.playerDiagnostics.getEngine();return {active:e.active.map(d=>d?.cue.name),fps:e.fps,memory:e.memory};}));
 for(let i=0;i<10;i++)await page.evaluate(()=>window.playerDiagnostics.openOutput('pgm'));console.log('OPENED10');
}catch(e){console.error(e);console.log('CONTENTS',await app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>({url:w.getURL(),pid:w.getOSProcessId()}))));throw e;}finally{console.log('CLOSING');await app.close();console.log('CLOSED');}
