const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
 const p=await browser.newPage({viewport:{width:393,height:852}});
 let active=0,maxActive=0,requests=[],mode='normal';const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=(url,opts={})=>{
   if(String(url)==='/chat'&&window.mockStalledLLM){
    let c;const stream=new ReadableStream({start(x){c=x;x.enqueue(new TextEncoder().encode('今天我们来测试一个完整句子，确保合成失败能立即停下而不是等到聊天结束。'));}});
    opts.signal?.addEventListener('abort',()=>{try{c.error(new DOMException('Aborted','AbortError'));}catch{}});
    return Promise.resolve(new Response(stream,{headers:{'content-type':'text/plain'}}));
   }
   return original(url,opts);
  };
 });
 await p.route('http://127.0.0.1:3457/**',async route=>{
  const u=new URL(route.request().url());
  if(['/','/client.js','/pcm-worklet.js'].includes(u.pathname))return route.fulfill({contentType:u.pathname==='/'?'text/html':'text/javascript',body:fs.readFileSync(path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1)))});
  if(u.pathname==='/health')return route.fulfill({json:{ok:true}});
  if(u.pathname==='/chat')return route.fulfill({contentType:'text/plain',body:'今天忙完以后先坐下休息一会儿，慢慢说清楚心里想做的事情。饭已经热好了，等你吃完我们再收拾厨房，把明早出门要带的东西都准备好。要是还有精神，就去楼下慢慢走一圈，回来以后早点休息。明天的事情可以明天再安排，不用今晚全都想清楚。真的做不完也没关系，先把最重要的两三件挑出来。剩下的周末再补，也来得及。'});
  if(u.pathname==='/ttsstream'){
   const ix=requests.length;const text=JSON.parse(route.request().postData()).text;requests.push({ix,text,at:Date.now()});active++;maxActive=Math.max(maxActive,active);
   try{
    if(mode==='failure')return await route.fulfill({status:502,body:'bad audio'});
    await new Promise(r=>setTimeout(r,ix===0?400:120));
    const pcm=Buffer.alloc(24000*2*.35);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(Math.sin(i/24000*2*Math.PI*220)*3000),i*2);
    return await route.fulfill({contentType:'application/octet-stream',body:pcm});
   }finally{active--;}
  }
  return route.fulfill({status:404});
 });
 await p.goto('http://127.0.0.1:3457/');await p.fill('#txt','测试长段');await p.click('#send');
 await p.waitForFunction(()=>document.body.dataset.state==='muted',{timeout:15000});
 assert.ok(requests.length>=3);assert.equal(maxActive,2,'at most two synthesis requests');
 const traces=await p.evaluate(()=>window.voiceDiagnostics);
 assert.deepEqual(traces.filter(x=>x.kind==='queued').map(x=>x.segment),requests.map(x=>x.ix),'strict ordered playback despite response inversion');
 assert.ok(requests[1].at-requests[0].at<200,'lookahead does not wait for previous EOF');
 assert.ok(traces.filter(x=>x.kind==='audible-segment').length===requests.length);
 mode='failure';await p.evaluate(()=>window.mockStalledLLM=true);await p.fill('#txt','立即错误测试');const begin=Date.now();await p.click('#send');
 await p.waitForFunction(()=>document.body.dataset.state==='error',{timeout:2000});assert.ok(Date.now()-begin<2000,'fail before stalled LLM EOF');
 await p.click('#hangup');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,requests:requests.length,maxConcurrent:maxActive,checks:['2-request bounded prefetch','response inversion keeps order','actual playback notifications','failure cancels stalled LLM immediately','no page errors']},null,2));
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
