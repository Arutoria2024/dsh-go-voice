const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const p=await browser.newPage();
 const inject=`  window.__bargeTest=(level,rms,count)=>{
    ctx={sampleRate:48000};initialized=true;phase='speaking';lastPlaybackLevel=level;speakingFrames=0;capture=[];lead=[];
    turn={abort:{abort(){}},completedText:'',committed:true,started:0,jobs:0,epoch:1};
    const buf=new Float32Array(1024);for(let i=0;i<buf.length;i++)buf[i]=(i%2?rms:-rms);
    for(let k=0;k<count;k++)onMic(buf);
    const cancelled=turn===null;turn=null;phase='idle';lastPlaybackLevel=0;ctx=undefined;initialized=false;return {cancelled};
  };
  state('idle');
})();`;
 await p.route('http://127.0.0.1:3457/**',route=>{const u=new URL(route.request().url());let body=fs.readFileSync(path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1)),'utf8');if(u.pathname==='/client.js')body=body.replace("  state('idle');\n})();",inject);return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body});});
 await p.goto('http://127.0.0.1:3457/');
 const r=await p.evaluate(()=>({
   echoSameLevel: window.__bargeTest(0.15,0.15,10),   // loudspeaker echo ~ same level as output
   echoBelowGate: window.__bargeTest(0.2,0.25,10),    // slightly above output but below 1.7x gate
   realVoiceLoud: window.__bargeTest(0.1,0.40,10),    // genuine near-mic voice beats playback
   quietNoise: window.__bargeTest(0,0.10,10)          // background below floor
 }));
 assert.equal(r.echoSameLevel.cancelled,false,'equal-level echo must not interrupt');
 assert.equal(r.echoBelowGate.cancelled,false,'sub-1.7x echo must not interrupt');
 assert.equal(r.realVoiceLoud.cancelled,true,'clearly louder voice must interrupt');
 assert.equal(r.quietNoise.cancelled,false,'quiet noise must not interrupt');
 console.log(JSON.stringify({passed:true,checks:['echo at same level does not barge-in','sub-threshold echo ignored','genuine loud voice still barges in','quiet background ignored'],detail:r},null,2));
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
