const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),DIR=path.join(ROOT,'diagnostics/length-20261105');
(async()=>{let browser;const results=[];try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
 for(const n of [30,50]){
  const meta=JSON.parse(fs.readFileSync(path.join(DIR,'result-'+n+'.json'))),pcm=fs.readFileSync(path.join(DIR,'response-'+n+'.bin'));
  const page=await browser.newPage({viewport:{width:393,height:852}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({meta,data})=>{
   const original=window.fetch;const raw=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
   window.fetch=(url,opts={})=>{
    if(String(url)==='/chat')return Promise.resolve(new Response(meta.text,{headers:{'content-type':'text/plain'}}));
    if(String(url)==='/ttsstream'){
     let controller,offset=0;const timers=[];
     const body=new ReadableStream({start(c){controller=c;for(const chunk of meta.chunks){timers.push(setTimeout(()=>{try{c.enqueue(raw.slice(offset,offset+chunk.bytes));offset+=chunk.bytes;}catch{}},chunk.atMs));}timers.push(setTimeout(()=>{try{c.close();window.ttsReplayEOF=performance.now();}catch{}},meta.eofMs+1));},cancel(){timers.forEach(clearTimeout);}});
     opts.signal?.addEventListener('abort',()=>{timers.forEach(clearTimeout);try{controller.error(new DOMException('Aborted','AbortError'));}catch{}});
     return Promise.resolve(new Response(body,{headers:{'content-type':'application/octet-stream'}}));
    }
    return original(url,opts);
   };
  },{meta,data:pcm.toString('base64')});
  await page.route('http://127.0.0.1:3457/**',route=>{const u=new URL(route.request().url());if(u.pathname==='/health')return route.fulfill({json:{ok:true}});if(['/','/client.js','/pcm-worklet.js'].includes(u.pathname)){
    let body=fs.readFileSync(path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1)),'utf8');
    // Isolate one recorded provider response per case. Production multi-segment order is covered by scheduler.test.
    if(u.pathname==='/client.js')body=body.replace('firstMax:40','firstMax:80');
    return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body});
   }return route.fulfill({status:404});});
  await page.goto('http://127.0.0.1:3457/');await page.fill('#txt','测试'+n+'字流式');await page.click('#send');
  await page.waitForFunction(()=>document.body.dataset.state==='muted'||document.body.dataset.state==='error',{timeout:45000});
  const r=await page.evaluate(()=>({state:document.body.dataset.state,trace:window.voiceDiagnostics,status:document.getElementById('status').textContent,eof:window.ttsReplayEOF,text:document.getElementById('log').textContent}));
  assert.equal(r.state,'muted',JSON.stringify(r));assert.deepEqual(errors,[]);
  const first=r.trace.find(x=>x.kind==='audible-segment');assert.ok(first,'audible event');console.log('REPLAY',n,JSON.stringify({firstAudibleMs:first.elapsedMs,lastEOF:r.eof}));assert.ok(first.at<r.eof,'starts before network EOF');
  assert.match(r.text,/今天/);
  results.push({length:n,firstAudibleMs:first.elapsedMs,sourceEOFMs:meta.eofMs,state:r.state,startsBeforeEOF:true,replayedRecordedBytes:pcm.length,note:'Exact prior single provider response replay in actual browser; test firstMax=80 isolates one recorded 30/50-character segment; production multi-segment order separately tested; no new cloud request; not physical DAC'});
  await page.click('#hangup');await page.close();
 }
 fs.writeFileSync(path.join(DIR,'progressive-browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({passed:true,results},null,2));
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
