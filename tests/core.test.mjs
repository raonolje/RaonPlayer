import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../src/core.cjs';
import path from 'node:path';
const {parseRange,normalizeProject,cachePlan,loopFramePlan}=core;
test('media ranges support seeks and suffixes, reject malformed requests',()=>{
 assert.deepEqual(parseRange(null,100),{start:0,end:99,partial:false});
 assert.deepEqual(parseRange('bytes=10-19',100),{start:10,end:19,partial:true});
 assert.deepEqual(parseRange('bytes=90-',100),{start:90,end:99,partial:true});
 assert.deepEqual(parseRange('bytes=-10',100),{start:90,end:99,partial:true});
 assert.deepEqual(parseRange('bytes=90-120',100),{start:90,end:99,partial:true});
 for(const r of ['bytes=100-','bytes=20-10','bytes=0-1,3-5','bytes=-0','bytes=-','garbage'])assert.equal(parseRange(r,100),null,r);
});
test('projects resolve relative assets and enforce four layers, ten views and geometry limits',()=>{
 const p=normalizeProject({schema:'raon-player/1',name:'공연',media:[{id:'a',path:'clips/a.mp4'}],cues:[{id:'cue',mediaId:'a',layer:30,in:-2,out:5,mode:'bad'}],layers:[{opacity:Infinity,scale:900}],output:{width:999999,height:0},views:['bad']},process.cwd());
 assert.equal(p.media[0].path,path.resolve('clips/a.mp4'));assert.equal(p.layers.length,4);assert.equal(p.views.length,10);assert.equal(p.cues[0].layer,3);assert.equal(p.cues[0].in,0);assert.equal(p.cues[0].mode,'once');assert.equal(p.layers[0].opacity,1);assert.equal(p.layers[0].scale,4);assert.equal(p.output.width,7680);assert.equal(p.output.height,64);
});
test('malformed projects cannot reference nonexistent or duplicate assets',()=>{
 assert.throws(()=>normalizeProject({schema:'wrong'},'.'));
 assert.throws(()=>normalizeProject({schema:'raon-player/1',media:[{id:'a',path:'a'},{id:'a',path:'b'}],cues:[]},'.'));
 assert.throws(()=>normalizeProject({schema:'raon-player/1',media:[],cues:[{id:'c',mediaId:'missing'}]},'.'));
 for(const id of ['', 'x'.repeat(81), '../bad'])assert.throws(()=>normalizeProject({schema:'raon-player/1',media:[{id:'m',path:'clip.mp4'}],cues:[{id,mediaId:'m'}]},'.'));
});
test('pingpong cache excludes duplicated endpoints and rejects excessive memory',()=>{
 const m={kind:'video',width:1920,height:1080,fps:30,duration:10};const plan=cachePlan(m,{in:1,out:3});assert.equal(plan.frames,60);assert.equal(plan.duration,118/30);assert.equal(plan.start,1);
 assert.throws(()=>cachePlan({...m,width:7680,height:4320},{in:0,out:10}),/캐시 예산/);
 assert.throws(()=>cachePlan(m,{in:3,out:2}),/3프레임/);
 assert.throws(()=>cachePlan({...m,kind:'image'},{in:0,out:2}));
});
test('decoded loops budget planar color, alpha and audio and use the complete pingpong cache',()=>{
 const m={kind:'video',width:576,height:720,fps:24,duration:4,alpha:true};
 const p=loopFramePlan(m,{in:1,out:3});assert.equal(p.frames,48);assert.equal(p.frameBytes,576*720*2.5);assert.equal(p.format,'I420A');assert.equal(p.duration,2);
 const cached=loopFramePlan({...m,duration:190/24},{in:1,out:3,playbackMediaId:'cached'});assert.equal(cached.frames,190);assert.equal(cached.start,0);
 const odd=loopFramePlan({...m,width:5,height:3,alpha:false,hasAudio:true},{in:0,out:1});assert.equal(odd.frameBytes,15+2*3*2);assert.equal(odd.audioBytes,48000*8);
 assert.throws(()=>loopFramePlan({...m,width:7680,height:4320,fps:60},{in:0,out:4}),/1 GiB/);
 for(const cue of [{in:-1,out:2},{in:1,out:1},{in:0,out:5}])assert.throws(()=>loopFramePlan(m,cue));
});
