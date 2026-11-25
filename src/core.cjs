const path = require('node:path');
const MAX_VIEWS = 10;
const MAX_LAYERS = 4;
const MODES = new Set(['once', 'loop', 'pingpong']);
function finite(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) { const suffix = Number(m[2]); if (suffix <= 0) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}
function normalizeProject(input, baseDir) {
  if (!input || input.schema !== 'raon-player/1') throw new Error('지원하지 않는 프로젝트 형식입니다.');
  if (!Array.isArray(input.media) || input.media.length > 10000 || !Array.isArray(input.cues) || input.cues.length > 10000) throw new Error('프로젝트 목록이 올바르지 않습니다.');
  const ids = new Set();
  const media = input.media.map(m => {
    if (!m || typeof m.id !== 'string' || !/^[\w-]{1,80}$/.test(m.id) || ids.has(m.id) || typeof m.path !== 'string' || !m.path || m.path.includes('\0')) throw new Error('미디어 항목이 올바르지 않습니다.');
    ids.add(m.id);
    return { id: m.id, path: path.resolve(baseDir, m.path), name: String(m.name || path.basename(m.path)).slice(0,256) };
  });
  const cueIds = new Set();
  const cues = input.cues.map(c => {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,80}$/.test(c.id) || cueIds.has(c.id) || !ids.has(c.mediaId)) throw new Error('큐의 미디어 연결이 올바르지 않습니다.');
    cueIds.add(c.id);
    return { id: c.id.slice(0,80), name: String(c.name || '큐').slice(0,256), mediaId: c.mediaId,
      playbackMediaId: ids.has(c.playbackMediaId) ? c.playbackMediaId : null,
      layer: Math.round(finite(c.layer,0,3,0)), in: finite(c.in,0,86400,0), out: finite(c.out,0,86400,0),
      mode: MODES.has(c.mode) ? c.mode : 'once', auto: !!c.auto };
  });
  const layers = Array.from({length:4},(_,i) => {
    const l = input.layers?.[i] || {};
    return { opacity: finite(l.opacity,0,1,1), x:finite(l.x,-16384,16384,0), y:finite(l.y,-16384,16384,0), scale:finite(l.scale,0.05,4,1), fit:['contain','cover','stretch'].includes(l.fit)?l.fit:'contain', mute:l.mute!==false, enabled:l.enabled!==false };
  });
  const output = { width:Math.round(finite(input.output?.width,64,7680,1920)),height:Math.round(finite(input.output?.height,64,4320,1080)),fps:input.output?.fps===30?30:60 };
  const allowed=['pgm','pvw','layer0','layer1','layer2','layer3'];
  const views=Array.from({length:MAX_VIEWS},(_,i)=>allowed.includes(input.views?.[i])?input.views[i]:(i===0?'pgm':i===1?'pvw':`layer${(i-2)%4}`));
  return { schema:'raon-player/1',name:String(input.name||'새 공연').slice(0,100),media,cues,layers,output,views };
}
function cachePlan(media, cue, budget=1024*1024*1024) {
  if(!Number.isFinite(media.width)||!Number.isFinite(media.height)||media.width<1||media.height<1||!Number.isFinite(media.duration)||media.duration<=0)throw new Error('FFprobe로 영상 크기와 길이를 먼저 확인해야 합니다.');
  const fps=Math.min(60,Math.max(1,media.fps || 30));
  const start=finite(cue.in,0,media.duration,0), end=finite(cue.out,0,media.duration,media.duration);
  const frames=Math.round((end-start)*fps);
  if (media.kind!=='video' || frames<3 || end<=start) throw new Error('핑퐁 구간은 3프레임 이상인 영상이어야 합니다.');
  const estimatedBytes=media.width*media.height*4*frames;
  if (end-start>12 || estimatedBytes>budget) throw new Error('핑퐁 구간이 캐시 예산(12초 / 비압축 추정 1 GiB)을 초과합니다. 구간을 줄여 주세요.');
  return { start, end, fps, frames, duration:(frames*2-2)/fps, estimatedBytes };
}
function loopFramePlan(media,cue,budget=1024*1024*1024){
 if(media.kind!=='video'||![media.width,media.height,media.duration].every(n=>Number.isFinite(n)&&n>0))throw new Error('반복 프레임을 준비할 영상 정보가 없습니다.');
 const start=cue.playbackMediaId?0:Number(cue.in),end=cue.playbackMediaId?media.duration:Number(cue.out||media.duration);
 const fps=Math.min(60,Math.max(1,media.fps||30)),frames=Math.round((end-start)*fps);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>media.duration+.001||frames<1||end<=start)throw new Error('반복 IN / OUT 구간을 확인하세요.');
 const chroma=Math.ceil(media.width/2)*Math.ceil(media.height/2),frameBytes=media.width*media.height*(media.alpha?2:1)+2*chroma;
 const bytes=frameBytes*frames,audioBytes=media.hasAudio?Math.ceil(frames/fps*48000)*8:0;
 if(bytes+audioBytes>budget)throw new Error('무공백 반복 프레임 캐시가 1 GiB 한도를 초과합니다. 반복 구간을 줄이세요.');
 return {start,end,fps,frames,width:media.width,height:media.height,frameBytes,bytes,audioBytes,duration:frames/fps,format:media.alpha?'I420A':'I420'};
}
module.exports={MAX_VIEWS,MAX_LAYERS,finite,parseRange,normalizeProject,cachePlan,loopFramePlan};
