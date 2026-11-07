const {chromium}=require('playwright');const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{let b;try{b=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const p=await b.newPage();const root=path.resolve(__dirname,'..');
 await p.route('http://127.0.0.1:3457/**',route=>{const u=new URL(route.request().url());let body=fs.readFileSync(path.join(root,u.pathname==='/'?'page.html':u.pathname.slice(1)),'utf8');if(u.pathname==='/client.js')body=body.replace("  state('idle');\n})();","  window.__dspTest={splitPending,polish,resample,wav,TUNE,DSP,createProgressiveDSP};\n  state('idle');\n})();");return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body});});
 await p.goto('http://127.0.0.1:3457/');const result=await p.evaluate(()=>{
  const {splitPending,polish,resample,TUNE,DSP,createProgressiveDSP}=window.__dspTest;
  const inputs=['嗯，我在听。今天辛苦了，先坐下来歇会儿，慢慢说。','这是没有标点的很长一段话'.repeat(30),'明天10:30开始，预算3.14元，版本v2.0.1，路径等信息应留在消息里。','你好。','今天想聊点什么？'.repeat(20)];
  const preserved=[];
  for(const text of inputs){for(const batch of [1,3,9,1000]){let pending='',first=true,parts=[];const drain=final=>{while(pending){const x=splitPending(pending,final,first);if(!x.part)break;parts.push(x.part);pending=x.rest;first=false;}};for(let i=0;i<text.length;i+=batch){pending+=text.slice(i,i+batch);drain(false);}drain(true);if(pending)parts.push(pending);preserved.push(parts.join('')===text);}}
  const pcm=new Float32Array(24000);for(let i=0;i<pcm.length;i++)pcm[i]=Math.sin(2*Math.PI*220*i/24000)*.7;
  polish(pcm);let peak=0,sum=0;for(const x of pcm){peak=Math.max(peak,Math.abs(x));sum+=x*x;}
  const silent=new Float32Array(4);polish(silent);const native=resample(pcm,24000,48000);const down=resample(native,48000,24000);
  const raw=new Uint8Array(24000*2);const dv=new DataView(raw.buffer);
  for(let i=0;i<24000;i++)dv.setInt16(i*2,Math.round(Math.sin(2*Math.PI*220*i/24000)*5000),true);
  const streamChecks=[];
  for(const rate of [24000,44100,48000]){
    const one=createProgressiveDSP(rate),a=one.process(raw,true);
    const streaming=createProgressiveDSP(rate),parts=[];
    for(let i=0;i<raw.length;i+=4095)parts.push(streaming.process(raw.subarray(i,i+4095),false));
    parts.push(streaming.process(new Uint8Array(0),true));
    const n=parts.reduce((v,x)=>v+x.length,0),joined=new Float32Array(n);let at=0;for(const x of parts){joined.set(x,at);at+=x.length;}
    // Progressive gain calibrates from first 250ms; stable sine has the same voiced RMS.
    let peak=0,jump=0;for(let i=0;i<joined.length;i++){peak=Math.max(peak,Math.abs(joined[i]));if(i)jump=Math.max(jump,Math.abs(joined[i]-joined[i-1]));}
    streamChecks.push({rate,length:joined.length,expected:Math.round(rate/DSP.pitch),finite:[...joined].every(Number.isFinite),peak,jump,tail:joined[joined.length-1]});
  }
  let oddRejected=false;try{createProgressiveDSP(48000).process(new Uint8Array(3),true);}catch{oddRejected=true;}
  return {streamChecks,oddRejected,preserved:preserved.every(Boolean),cases:preserved.length,peak,rms:Math.sqrt(sum/pcm.length),first:pcm[0],last:pcm[pcm.length-1],silenceFinite:[...silent].every(Number.isFinite),upsampleLength:native.length,downsampleLength:down.length,allResampledFinite:[...native].every(Number.isFinite),tune:TUNE};
 });
 for(const check of result.streamChecks){assert.ok(Math.abs(check.length-check.expected)<=1);assert.equal(check.finite,true);assert.ok(check.peak<=.94);assert.ok(check.jump<.1);assert.ok(Math.abs(check.tail)<1e-6);}assert.equal(result.oddRejected,true);assert.equal(result.preserved,true);assert.ok(result.peak<=.94);assert.ok(Math.abs(result.first)===0);assert.ok(Math.abs(result.last)===0);assert.equal(result.silenceFinite,true);assert.equal(result.upsampleLength,48000);assert.equal(result.downsampleLength,24000);assert.equal(result.allResampledFinite,true);console.log(JSON.stringify({passed:true,...result},null,2));
}finally{await b?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
