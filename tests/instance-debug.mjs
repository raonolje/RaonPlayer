import {_electron as electron} from 'playwright';import {spawn} from 'node:child_process';import path from 'node:path';
const profile=path.resolve('../../work/hard-tests/instance-profile');const app=await electron.launch({args:[process.cwd(),`--user-data-dir=${profile}`],env:{...process.env,PLAYER_TEST:'1'}});
try{console.log(await app.evaluate(({app})=>({args:process.argv,path:app.getPath('userData'),lock:app.hasSingleInstanceLock(),exe:process.execPath})));
const exe=await app.evaluate(()=>process.execPath);const child=spawn(exe,[process.cwd(),`--user-data-dir=${profile}`],{env:{...process.env,PLAYER_TEST:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stdout.write(b));console.log('spawn',child.pid);await new Promise(r=>{const timer=setTimeout(()=>{child.kill();r();},6000);child.on('close',(code)=>{console.log('second closed',code);clearTimeout(timer);r();});});
}finally{await app.close();}
