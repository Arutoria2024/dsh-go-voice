const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const p=await browser.newPage();
 await p.route('http://127.0.0.1:3457/**',route=>{const u=new URL(route.request().url());let body=fs.readFileSync(path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1)),'utf8');if(u.pathname==='/client.js')body=body.replace("  state('idle');\n})();","  window.__seam={TUNE,DSP,createProgressiveDSP};\n  state('idle');\n})();");return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body});});
 await p.goto('http://127.0.0.1:3457/');
 const r=await p.evaluate(()=>{
  const {TUNE,DSP,createProgressiveDSP}=window.__seam;
  const SRc=24000; const make=(amp)=>{const raw=new Uint8Array(SRc*2*.8);const dv=new DataView(raw.buffer);for(let i=0;i<raw.length/2;i++)dv.setInt16(i*2,Math.round(Math.sin(2*Math.PI*200*i/SRc)*amp),true);return raw;};
  const shared={gain:null};
  const run=(raw,isFirst)=>{const d=createProgressiveDSP(48000,shared,isFirst);const parts=[];for(let i=0;i<raw.length;i+=4000)parts.push(d.process(raw.subarray(i,i+4000),false));parts.push(d.process(new Uint8Array(0),true));const n=parts.reduce((a,x)=>a+x.length,0),o=new Float32Array(n);let at=0;for(const x of parts){o.set(x,at);at+=x.length;}return o;};
  // Two segments with very different source loudness must be gain-matched at the seam.
  const a=run(make(1500),true); const gA=shared.gain;
  const b=run(make(9000),false); const gB=shared.gain;
  const firstZero=Math.abs(a[0])<1e-6, lastZero=Math.abs(a[a.length-1])<1e-6;
  const bFirstZ=Math.abs(b[0])<1e-6, bLastZ=Math.abs(b[b.length-1])<1e-6;
  let bFinite=true;for(const x of b)if(!Number.isFinite(x))bFinite=false;
  return {gA,gB,gainRatio:gB/gA,firstZero,lastZero,bFirstZ,bLastZ,bFinite,tune:TUNE,pitch:DSP.pitch};
 });
 assert.ok(r.gainRatio>=0.9&&r.gainRatio<=1.1,'shared gain stays within +-10% at seam: '+r.gainRatio);
 assert.equal(r.firstZero,true);assert.equal(r.lastZero,true);assert.equal(r.bFirstZ,true);assert.equal(r.bLastZ,true);assert.equal(r.bFinite,true);
 assert.equal(r.pitch,1,'pitch back to original');
 assert.equal(r.tune.pauseMs,200);
 console.log(JSON.stringify({passed:true,checks:['seam gain within +-10%','each segment fades to zero at both ends','samples finite','pitch restored'],detail:r},null,2));
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
