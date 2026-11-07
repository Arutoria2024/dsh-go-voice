const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const p=await browser.newPage();
 await p.route('http://127.0.0.1:3457/**',route=>{const u=new URL(route.request().url());const f=path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1));return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body:fs.readFileSync(f,'utf8')});});
 await p.goto('http://127.0.0.1:3457/');
 await p.waitForFunction(()=>!!window.__vp,{timeout:5000});
 const r=await p.evaluate(()=>{
  const sr=48000;
  const synth=(pitch,formants,dur=5)=>{const n=Math.floor(dur*sr),x=new Float32Array(n);for(let i=0;i<n;i++){const t=i/sr,f0=pitch*(1+0.012*Math.sin(2*Math.PI*5*t));let v=0;for(let h=1;h<=40;h++){const f=f0*h;if(f>=sr/2)break;let a=0;for(const[ff,bw,g]of formants)a+=g/(1+Math.pow((f-ff)/(bw/2),2));v+=a*Math.sin(2*Math.PI*f*t);}x[i]=v;}let pk=0;for(const v of x)pk=Math.max(pk,Math.abs(v));for(let i=0;i<n;i++)x[i]*=0.3/(pk||1);return x;};
  const noise=(dur=3)=>{const n=Math.floor(dur*sr),x=new Float32Array(n);for(let i=0;i<n;i++)x[i]=(Math.random()*2-1)*0.15;return x;};
  const A=synth(200,[[500,110,1],[1500,160,0.6],[2800,220,0.3]]);
  const B=synth(330,[[820,130,1],[2300,180,0.7],[3300,220,0.45]]);
  const A2=synth(205,[[500,110,1],[1500,160,0.62],[2800,220,0.3]],3); // same speaker, slightly different
  const prof=window.__vp.enrollFromBuffer(A,sr);
  window.__vp.setProfile(prof);window.__vp.setEnabled(true);
  const fA=window.__vp.computeVoiceFeatures(A2,sr),fB=window.__vp.computeVoiceFeatures(B,sr),fN=window.__vp.computeVoiceFeatures(noise(),sr);
  const sA=window.__vp.voiceprintScore(prof,fA),sB=window.__vp.voiceprintScore(prof,fB),sN=window.__vp.voiceprintScore(prof,fN);
  return {prof:{threshold:prof.threshold,frames:prof.frames,minSim:prof.minSim,meanSim:prof.meanSim,pitch:prof.pitch},
    sA,sB,sN, sameAccepted:window.__vp.verifyVoice(A2,sr), otherRejected:!window.__vp.verifyVoice(B,sr), noiseRejected:!window.__vp.verifyVoice(noise(),sr)};
 });
 assert.ok(r.prof && r.prof.frames>=3,'enrollment built from windows: '+JSON.stringify(r.prof));
 assert.ok(r.sA>r.sB,'same speaker scores higher than other: '+r.sA+' vs '+r.sB);
 assert.equal(r.sameAccepted,true,'enrolled speaker accepted');
 assert.equal(r.otherRejected,true,'different speaker rejected');
 assert.equal(r.noiseRejected,true,'broadband noise rejected');
 console.log(JSON.stringify({passed:true,checks:['voiceprint enroll builds profile','same speaker > other speaker','same accepted, other rejected, noise rejected'],detail:r},null,2));
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
