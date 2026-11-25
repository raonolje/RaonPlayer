const {app,BrowserWindow,protocol,ipcMain,dialog,screen,Menu} = require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Readable}=require('node:stream');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {parseRange,normalizeProject,cachePlan,loopFramePlan}=require('./core.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'player',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}},{scheme:'media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
const singleInstance=app.requestSingleInstanceLock();
if(!singleInstance)app.quit();
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
// Keep DirectComposition while selecting Chromium's primary-plane BufferQueue.
// This is app-scoped; hardware WebGL and output rendering remain enabled.
if(process.platform==='win32')app.commandLine.appendSwitch('enable-features','BufferQueue');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('disable-background-timer-throttling');
let main,engineHost,engineReadyResolve,previewPending=false,snapshotPending=false,closing=false;const engineReady=new Promise(r=>engineReadyResolve=r),engineRequests=new Map();
let enginePriorityError=null;
// Scope Windows High (not realtime) priority to the playback/output renderer.
// The operator and unrelated apps keep their existing priority.
function prioritizeEngine(){
 if(process.platform!=='win32'||closing||!engineHost||engineHost.isDestroyed()||engineHost.webContents.isDestroyed())return;
 try{const pid=engineHost.webContents.getOSProcessId();if(pid>0&&os.getPriority(pid)!==os.constants.priority.PRIORITY_HIGH)os.setPriority(pid,os.constants.priority.PRIORITY_HIGH);enginePriorityError=null;}catch(e){enginePriorityError=e.message;}
}
function isMain(sender){return !!main&&!main.isDestroyed()&&sender.id===main.webContents.id;}
function isEngine(sender){return !!engineHost&&!engineHost.isDestroyed()&&sender.id===engineHost.webContents.id;}
let projectPath=null, ffmpeg='ffmpeg', ffprobe='ffprobe',autosaveQueue=Promise.resolve();
app.on('before-quit',()=>{closing=true;});
app.on('second-instance',()=>{if(main&&!main.isDestroyed()){if(main.isMinimized())main.restore();if(!process.env.PLAYER_TEST){main.show();main.focus();}}});
const media=new Map(),jobs=new Map();
const UI=path.join(__dirname,'ui');
const mime={'.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const csp="default-src 'self'; script-src 'self'; style-src 'self'; media-src media: blob:; img-src 'self' media: data: blob:; connect-src 'self' media:; object-src 'none'; frame-src 'none'; base-uri 'none'";
async function atomicWrite(file,text){const temp=file+'.'+randomUUID()+'.tmp';try{await fsp.writeFile(temp,text,'utf8');await fsp.rename(temp,file);}finally{await fsp.rm(temp,{force:true}).catch(()=>{});}}
async function findTool(name){
  const options=[process.env[name.toUpperCase()+'_PATH'],`C:/ffmpeg/bin/${name}.exe`,name].filter(Boolean);
  for(const candidate of options){try {await run(candidate,['-version'],15000);return candidate;}catch{}}
  return null;
}
function run(bin,args,timeout=30000,jobId=null){return new Promise((resolve,reject)=>{
 if(!bin)return reject(new Error('FFmpeg / FFprobe를 찾지 못했습니다. C:\\ffmpeg\\bin 또는 PATH를 확인해 주세요.'));
 const child=spawn(bin,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});if(jobId)jobs.set(jobId,child);
 let stdout='',stderr='',done=false;const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);if(jobId)jobs.delete(jobId);err?reject(err):resolve(result);};
 const timer=setTimeout(()=>{child.kill();finish(new Error('미디어 처리 제한 시간을 초과했습니다.'));},timeout);
 child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-2000000);});
 child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16000);if(jobId&&main&&!main.isDestroyed())main.webContents.send('job-progress',{id:jobId,text:stderr.split(/[\r\n]/).filter(Boolean).at(-1)||''});});
 child.on('error',e=>finish(e));child.on('close',code=>finish(code===0?null:new Error('미디어 처리 실패: '+stderr.slice(-1600)),stdout));
 });}
async function register(file,id=randomUUID()){
 const absolute=path.resolve(file);const st=await fsp.stat(absolute);if(!st.isFile())throw new Error('일반 파일만 불러올 수 있습니다.');
 const image=['.png','.jpg','.jpeg','.webp'].includes(path.extname(absolute).toLowerCase());
 let details={};
 if(ffprobe){try{const data=JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',absolute]));const v=data.streams?.find(s=>s.codec_type==='video');if(!v)throw new Error('영상 스트림이 없습니다.');const [a,b]=String(v.avg_frame_rate||'0/1').split('/').map(Number);details={width:v.width,height:v.height,fps:b?a/b:0,duration:Number(data.format?.duration||v.duration)||0,codec:v.codec_name,hasAudio:data.streams.some(s=>s.codec_type==='audio'),alpha:!!((v.tags?.alpha_mode||v.tags?.ALPHA_MODE)==='1'||/yuva|rgba|bgra|argb|abgr|gbrap/.test(v.pix_fmt||''))};}catch(e){if(!image)throw e;}}
 const item={id,path:absolute,name:path.basename(absolute),kind:image?'image':'video',size:st.size,modified:st.mtimeMs,...details};media.set(id,item);return {...item,url:`media://asset/${id}`};
}
function bind(name,handler){ipcMain.handle(name,async(event,...args)=>{
 if(!isMain(event.sender)&&!isEngine(event.sender))throw new Error('허용되지 않은 창입니다.');
 return handler(...args);
});}
async function serve(request,file,extra={}){
 const st=await fsp.stat(file);const range=parseRange(request.headers.get('range'),st.size);
 if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${st.size}`}});
 const headers={'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Content-Length':String(range.end-range.start+1),...extra};
 if(range.partial)headers['Content-Range']=`bytes ${range.start}-${range.end}/${st.size}`;
 if(request.method==='HEAD')return new Response(null,{status:range.partial?206:200,headers});
 return new Response(Readable.toWeb(fs.createReadStream(file,{start:range.start,end:range.end})),{status:range.partial?206:200,headers});
}
function setupProtocols(){
 protocol.handle('player',async req=>{try{const url=new URL(req.url);if(!['app','engine'].includes(url.host))return new Response(null,{status:403});const filename=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);const full=path.resolve(UI,'.'+filename);if(!full.startsWith(UI+path.sep))return new Response(null,{status:403});return await serve(req,full,{'Content-Security-Policy':csp});}catch{return new Response('Not found',{status:404});}});
 protocol.handle('media',async req=>{try{const u=new URL(req.url),item=media.get(u.pathname.slice(1));if(u.host!=='asset'||!item)return new Response(null,{status:404});return await serve(req,item.path,{'Access-Control-Allow-Origin':new URL(req.headers.get('origin')||'player://app').host==='engine'?'player://engine':'player://app'});}catch{return new Response('Media missing',{status:404});}});
}
if(singleInstance)app.whenReady().then(async()=>{
 app.setAppUserModelId('kr.raon.local-player');
 [ffmpeg,ffprobe]=await Promise.all([findTool('ffmpeg'),findTool('ffprobe')]);
 setupProtocols();Menu.setApplicationMenu(null);
 main=new BrowserWindow({width:1600,height:980,minWidth:1180,minHeight:760,backgroundColor:'#071322',title:'Raon Local Player',icon:path.join(__dirname,'assets','raon-player.ico'),show:!process.env.PLAYER_TEST,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 engineHost=new BrowserWindow({show:false,width:1920,height:1080,backgroundColor:'#000000',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 engineHost.webContents.on('did-finish-load',prioritizeEngine);main.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 engineHost.webContents.setWindowOpenHandler(({url})=>{
  try{const u=new URL(url);if(u.protocol!=='player:'||u.host!=='engine'||u.pathname!=='/output.html'||u.searchParams.get('output')!=='1')return {action:'deny'};
   if(BrowserWindow.getAllWindows().filter(w=>w!==main&&w!==engineHost).length>=10)return {action:'deny'};
   const d=screen.getAllDisplays().find(d=>String(d.id)===u.searchParams.get('display'))||screen.getPrimaryDisplay();
   return {action:'allow',overrideBrowserWindowOptions:{x:d.bounds.x+40,y:d.bounds.y+40,width:960,height:540,show:false,fullscreen:false,backgroundColor:'#000000',title:'Raon · Output',icon:path.join(__dirname,'assets','raon-player.ico'),autoHideMenuBar:true,webPreferences:{preload:undefined,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}}};
  }catch{return {action:'deny'};}
 });
 for(const [win,host] of [[main,'app'],[engineHost,'engine']])win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('player://'+host+'/'))event.preventDefault();});
 engineHost.webContents.on('did-create-window',win=>{win.on('close',event=>{if(closing)return;event.preventDefault();win.hide();if(engineHost&&!engineHost.isDestroyed()){const id=new URL(win.webContents.getURL()).searchParams.get('id');engineHost.webContents.send('output-closed',id);}});win.webContents.on('before-input-event',(_,input)=>{if(input.key==='Escape')win.setFullScreen(false);});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('player://engine/'))e.preventDefault();});});
 const startupTimer=setTimeout(()=>engineReadyResolve({error:'재생 엔진을 초기화하지 못했습니다. GPU 드라이버를 확인하고 앱을 다시 실행하세요.'}),15000);startupTimer.unref();
 ipcMain.on('engine-ready',event=>{if(isEngine(event.sender)){prioritizeEngine();clearTimeout(startupTimer);engineReadyResolve();}});
 ipcMain.on('snapshot-ack',event=>{if(isMain(event.sender))snapshotPending=false;});
 ipcMain.on('engine-reply',(event,data)=>{if(!isEngine(event.sender))return;prioritizeEngine();const r=engineRequests.get(data.id);if(r){clearTimeout(r.timer);engineRequests.delete(data.id);r.resolve(data);}});
 ipcMain.on('preview-ack',event=>{if(isMain(event.sender)&&previewPending){previewPending=false;if(engineHost&&!engineHost.isDestroyed())engineHost.webContents.send('preview-credit');}});
 ipcMain.on('engine-preview',(event,data)=>{if(isEngine(event.sender)&&main&&!main.isDestroyed()&&!previewPending){previewPending=true;main.webContents.send('engine-preview',data);}});
 ipcMain.on('engine-event',(event,data)=>{if(isEngine(event.sender)&&main&&!main.isDestroyed()){prioritizeEngine();if(data.event==='snapshot'){if(snapshotPending)return;snapshotPending=true;}main.webContents.send('engine-event',data);}});
 bind('engine-command',async(method,payload)=>{const startup=await engineReady;if(startup?.error)throw new Error(startup.error);if(engineHost.isDestroyed()||engineHost.webContents.isCrashed())throw new Error('재생 프로세스가 중단되었습니다. 앱을 다시 실행하세요.');return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{engineRequests.delete(id);reject(new Error('재생 명령 응답 시간이 초과되었습니다.'));},120000);engineRequests.set(id,{resolve,reject,timer});engineHost.webContents.send('engine-command',{id,method,payload});});});
 engineHost.webContents.on('render-process-gone',(_,details)=>{for(const r of engineRequests.values()){clearTimeout(r.timer);r.reject(new Error('재생 프로세스 중단: '+details.reason));}engineRequests.clear();if(!main.isDestroyed())main.webContents.send('engine-event',{event:'error',data:'재생 프로세스가 중단되었습니다. 앱을 다시 실행하세요.'});});
 main.on('close',()=>{closing=true;for(const r of engineRequests.values()){clearTimeout(r.timer);r.reject(new Error('앱 종료'));}engineRequests.clear();for(const w of BrowserWindow.getAllWindows())if(w!==main&&w!==engineHost){w.destroy();}if(engineHost&&!engineHost.isDestroyed()){engineHost.destroy();}for(const child of jobs.values())child.kill();});
 bind('environment',()=>({ffmpeg:!!ffmpeg,ffprobe:!!ffprobe,version:app.getVersion(),enginePriorityError,cacheDir:path.join(app.getPath('userData'),'loop-cache'),displays:screen.getAllDisplays().map(d=>({id:d.id,label:d.label||`Display ${d.id}`,bounds:d.bounds,scaleFactor:d.scaleFactor})),gpu:app.getGPUFeatureStatus()}));
 bind('configure-output',(pool,display,full,visible)=>{const win=BrowserWindow.getAllWindows().find(w=>{try{return new URL(w.webContents.getURL()).searchParams.get('pool')===pool;}catch{return false;}});if(!win)throw new Error('준비된 출력 창이 없습니다. 앱을 다시 실행하세요.');if(!visible){win.hide();prioritizeEngine();return true;}const d=screen.getAllDisplays().find(d=>String(d.id)===String(display))||screen.getPrimaryDisplay();win.setFullScreen(false);win.setBounds({x:d.bounds.x+40,y:d.bounds.y+40,width:960,height:540});if(full)win.setFullScreen(true);if(!process.env.PLAYER_TEST)win.showInactive();prioritizeEngine();return true;});
 bind('output-fullscreen',(id,full)=>{const win=BrowserWindow.getAllWindows().find(w=>{try{return w!==main&&new URL(w.webContents.getURL()).searchParams.get('id')===id;}catch{return false;}});if(!win)return false;win.setFullScreen(typeof full==='boolean'?full:!win.isFullScreen());return true;});
 bind('import',async()=>{const result=await dialog.showOpenDialog(main,{title:'로컬 미디어 불러오기',properties:['openFile','multiSelections'],filters:[{name:'영상 / 이미지',extensions:['mp4','webm','mov','mkv','m4v','png','jpg','jpeg','webp']},{name:'모든 파일',extensions:['*']}]});if(result.canceled)return [];const results=[];for(const file of result.filePaths){try{results.push(await register(file));}catch(e){results.push({error:e.message,name:path.basename(file)});}}return results;});
 bind('import-paths',async paths=>{if(!Array.isArray(paths)||paths.length>200)throw new Error('파일 개수를 확인해 주세요.');const out=[];for(const file of paths){try{out.push(await register(String(file)));}catch(e){out.push({error:e.message,name:path.basename(String(file))});}}return out;});
 bind('save',async(project,saveAs=false)=>{
  let file=projectPath;if(!file||saveAs){const result=await dialog.showSaveDialog(main,{title:'프로젝트 저장',defaultPath:'공연.lmp',filters:[{name:'Raon Player Project',extensions:['lmp']}]});if(result.canceled)return null;file=result.filePath;}
  const base=path.dirname(file);const normalized=normalizeProject(project,base);
  normalized.media=normalized.media.map(m=>({id:m.id,name:m.name,path:path.relative(base,m.path)}));
  await atomicWrite(file,JSON.stringify(normalized,null,2));projectPath=file;return file;
 });
 bind('package-project',async data=>{
  const p=normalizeProject(data,app.getPath('userData'));
  const actual=[];for(const m of p.media){const registered=media.get(m.id);if(!registered)throw new Error('누락 미디어를 먼저 다시 연결해 주세요.');await fsp.access(registered.path);actual.push(registered);}
  const result=await dialog.showOpenDialog(main,{title:'공연 패키지를 저장할 폴더 선택',properties:['openDirectory','createDirectory']});if(result.canceled)return null;
  const dir=path.join(result.filePaths[0],'Raon-Show-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6));await fsp.mkdir(path.join(dir,'media'),{recursive:true});
  for(let i=0;i<p.media.length;i++){const m=p.media[i],name=m.id+'-'+path.basename(actual[i].path);await fsp.copyFile(actual[i].path,path.join(dir,'media',name),fs.constants.COPYFILE_EXCL);m.path=path.join('media',name);}
  const file=path.join(dir,'공연.lmp');await fsp.writeFile(file,JSON.stringify(p,null,2),'utf8');return file;
 });
 bind('demo',async()=>{
  const file=path.join(app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked','src','demo'):path.join(__dirname,'demo'),'데모.lmp');const project=normalizeProject(JSON.parse(await fsp.readFile(file,'utf8')),path.dirname(file));const list=[];for(const m of project.media)list.push({...await register(m.path,m.id),name:m.name});project.media=list;projectPath=null;return project;
 });
 bind('open',async()=>{
  const result=await dialog.showOpenDialog(main,{title:'프로젝트 열기',properties:['openFile'],filters:[{name:'Raon Player Project',extensions:['lmp']}]});if(result.canceled)return null;
  const file=result.filePaths[0];const stat=await fsp.stat(file);if(stat.size>20*1024*1024)throw new Error('프로젝트 파일이 너무 큽니다.');
  const project=normalizeProject(JSON.parse(await fsp.readFile(file,'utf8')),path.dirname(file));const loaded=[];
  for(const m of project.media){try{loaded.push({...await register(m.path,m.id),name:m.name,cache:project.cues.some(c=>c.playbackMediaId===m.id)});}catch{media.delete(m.id);loaded.push({...m,missing:true,url:null,kind:'video'});}}
  project.media=loaded;projectPath=file;return {project,path:file};
 });
 bind('relink',async id=>{if(typeof id!=='string')throw new Error('미디어 ID 오류');const r=await dialog.showOpenDialog(main,{title:'누락 미디어 다시 연결',properties:['openFile']});return r.canceled?null:register(r.filePaths[0],id);});
 bind('pingpong',async(mediaId,cue)=>{
  const m=media.get(mediaId);if(!m)throw new Error('미디어를 먼저 불러오세요.');const plan=cachePlan(m,cue);const alpha=m.alpha;
  const dir=path.join(app.getPath('userData'),'loop-cache');await fsp.mkdir(dir,{recursive:true});
  const key=createHash('sha256').update(JSON.stringify([m.path,m.modified,m.size,plan,'v3'])).digest('hex');const file=path.join(dir,key+(alpha?'.webm':'.mp4'));
  if(!fs.existsSync(file)){
   const temp=path.join(dir,key+'.partial'+(alpha?'.webm':'.mp4'));const args=['-y','-v','error','-stats','-ss',String(plan.start),'-t',String(plan.end-plan.start)];if(alpha&&m.codec==='vp9')args.push('-c:v','libvpx-vp9');
   args.push('-i',m.path,'-filter_complex',`[0:v]fps=${plan.fps},trim=end_frame=${plan.frames},setpts=PTS-STARTPTS,split[f][b];[b]reverse,trim=start_frame=1:end_frame=${plan.frames-1},setpts=PTS-STARTPTS[r];[f][r]concat=n=2:v=1:a=0[v]`,'-map','[v]','-an');
   args.push(...(alpha?['-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','18','-auto-alt-ref','0','-row-mt','1','-cpu-used','4']:['-c:v','libx264','-pix_fmt','yuv420p','-preset','fast','-crf','18','-movflags','+faststart']),temp);
   try{await run(ffmpeg,args,20*60*1000,'pingpong');await fsp.rename(temp,file);}catch(e){await fsp.rm(temp,{force:true});throw e;}
  }
  const result=await register(file);return {...result,name:`↔ ${m.name}`,cache:true,sourceId:m.id};
 });
 bind('loop-frames',async(id,cue,outputFps=60)=>{
  const m=media.get(id);if(!m)throw new Error('반복할 미디어가 없습니다.');
  const plan=loopFramePlan({...m,fps:Math.min(m.fps||30,outputFps===30?30:60)},cue),dir=path.join(app.getPath('userData'),'decoded-loops');await fsp.mkdir(dir,{recursive:true});
  const key=createHash('sha256').update(JSON.stringify([m.path,m.modified,m.size,plan,'decoded-v1'])).digest('hex');
  const file=path.join(dir,key+'.yuv'),audioFile=path.join(dir,key+'.f32');
  const valid=async(p,size)=>{try{return (await fsp.stat(p)).size===size;}catch{return false;}};
  if(!await valid(file,plan.bytes)){
   const temp=file+'.'+randomUUID()+'.partial',args=['-y','-v','error','-threads','2','-filter_threads','2'];
   if(m.alpha&&m.codec==='vp9')args.push('-c:v','libvpx-vp9');
   args.push('-i',m.path,'-vf',`trim=start=${plan.start}:end=${plan.end},setpts=PTS-STARTPTS,fps=${plan.fps},tpad=stop_mode=clone:stop_duration=1`,'-frames:v',String(plan.frames),'-an','-pix_fmt',m.alpha?'yuva420p':'yuv420p','-f','rawvideo',temp);
   try{await run(ffmpeg,args,20*60*1000,'loop-frames-'+randomUUID());if(!await valid(temp,plan.bytes))throw new Error('반복 프레임 캐시 길이가 일치하지 않습니다.');await fsp.rename(temp,file);}catch(e){await fsp.rm(temp,{force:true});throw e;}
  }
  let audioUrl=null;
  if(m.hasAudio){
   if(!await valid(audioFile,plan.audioBytes)){
    const temp=audioFile+'.'+randomUUID()+'.partial';
    try{await run(ffmpeg,['-y','-v','error','-i',m.path,'-vn','-af',`atrim=start=${plan.start}:end=${plan.end},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=end_sample=${Math.ceil(plan.duration*48000)}`,'-ac','2','-c:a','pcm_f32le','-f','f32le',temp],20*60*1000,'loop-audio-'+randomUUID());if(!await valid(temp,plan.audioBytes))throw new Error('반복 오디오 캐시 길이가 일치하지 않습니다.');await fsp.rename(temp,audioFile);}catch(e){await fsp.rm(temp,{force:true});throw e;}
   }
   const audioId='loop-a-'+key;media.set(audioId,{path:audioFile});audioUrl=`media://asset/${audioId}`;
  }
  const cacheId='loop-v-'+key;media.set(cacheId,{path:file});return {...plan,url:`media://asset/${cacheId}`,audioUrl};
 });
 bind('transcode',async id=>{
  const m=media.get(id);if(!m||m.kind!=='video')throw new Error('변환할 영상 파일을 선택해 주세요.');
  const dir=path.join(app.getPath('userData'),'compatible-media');await fsp.mkdir(dir,{recursive:true});
  const key=createHash('sha256').update(JSON.stringify([m.path,m.modified,m.size,'compatible-v1'])).digest('hex');const ext=m.alpha?'.webm':'.mp4';const file=path.join(dir,key+ext);
  if(!fs.existsSync(file)){
   const temp=path.join(dir,key+'.partial'+ext),args=['-y','-v','error','-stats'];if(m.alpha&&m.codec==='vp9')args.push('-c:v','libvpx-vp9');
   args.push('-i',m.path,'-map','0:v:0','-map','0:a?');
   args.push(...(m.alpha?['-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','18','-auto-alt-ref','0','-row-mt','1','-cpu-used','4','-c:a','libopus']:['-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-preset','fast','-crf','18','-c:a','aac','-movflags','+faststart']),temp);
   try{await run(ffmpeg,args,30*60*1000,'transcode');await fsp.rename(temp,file);}catch(e){await fsp.rm(temp,{force:true});throw e;}
  }
  return {...await register(file),name:m.name+' · 호환본',sourceId:id};
 });
 bind('cancel-job',()=>{for(const child of jobs.values())child.kill();return true;});
 bind('autosave',async project=>{const normalized=normalizeProject(project,app.getPath('userData'));const text=JSON.stringify(normalized,null,2);autosaveQueue=autosaveQueue.catch(()=>{}).then(()=>atomicWrite(path.join(app.getPath('userData'),'recovery.lmp'),text));await autosaveQueue;return true;});
 bind('recovery',async()=>{try{await autosaveQueue;const data=JSON.parse(await fsp.readFile(path.join(app.getPath('userData'),'recovery.lmp'),'utf8'));const project=normalizeProject(data,app.getPath('userData'));const loaded=[];for(const m of project.media){try{loaded.push({...await register(m.path,m.id),name:m.name,cache:project.cues.some(c=>c.playbackMediaId===m.id)});}catch{media.delete(m.id);loaded.push({...m,missing:true,kind:'video'});}}project.media=loaded;projectPath=null;return project;}catch{return null;}});
 const operatorLoad=main.loadURL('player://app/index.html');
 await engineHost.loadURL('player://engine/render-host.html');
 await operatorLoad;
});
app.on('window-all-closed',()=>app.quit());




