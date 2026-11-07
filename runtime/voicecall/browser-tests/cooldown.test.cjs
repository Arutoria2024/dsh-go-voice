const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const p=await browser.newPage();
 const inject=`  window.__cd={
    set(ms){initialized=true;micMuted=false;ctx={sampleRate:48000};turn=null;capture=[];voiced=0;quiet=0;speakingFrames=0;cooldownUntil=performance.now()+ms;},
    feed(rms,n){const b=new Float32Array(1024);for(let i=0;i<b.length;i++)b[i]=(i%2?rms:-rms);for(let k=0;k<n;k++)onMic(b);return {capture:capture.length,voiced:Number(voiced.toFixed(2))};}
  };
  state('idle');
})();`;
 await p.route('http://127.0.0.1:3457/**',route=>{const u=new URL(route.request().url());let body=fs.readFileSync(path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1)),'utf8');if(u.pathname==='/client.js')body=body.replace("  state('idle');\n})();",inject);return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body});});
 await p.goto('http://127.0.0.1:3457/');
 const r=await p.evaluate(()=>{
   window.__cd.set(1300); const during=window.__cd.feed(0.2,25);      // loud speech during cooldown
   window.__cd.set(0);    const after=window.__cd.feed(0.2,25);       // same speech after cooldown
   const quietDuring=window.__cd.set(1300)||window.__cd.feed(0.02,25);
   return {during, after, quietDuring};
 });
 assert.equal(r.during.capture,0,'cooldown ignores speech (no capture started)');
 assert.equal(r.during.voiced,0,'cooldown does not accumulate voiced time');
 assert.ok(r.after.capture>0,'after cooldown speech is captured again');
 assert.equal(r.quietDuring.capture,0,'quiet during cooldown stays ignored');
 console.log(JSON.stringify({passed:true,checks:['speech during cooldown ignored','voiced time not accumulated in cooldown','speech captured after cooldown','quiet ignored'],detail:r},null,2));
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
