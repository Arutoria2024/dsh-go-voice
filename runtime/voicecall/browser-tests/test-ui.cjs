const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({viewport:{width:393,height:852},deviceScaleFactor:2,isMobile:true,hasTouch:true,permissions:['microphone']});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let calls=0,ttsCalls=0,delay=0,breakNext=false;
 // Same browser UI and actual audio path; mock only paid network calls for repeatability.
 await page.route('http://127.0.0.1:3457/**',async route=>{
   const u=new URL(route.request().url());
   if(['/','/client.js','/pcm-worklet.js'].includes(u.pathname))return route.fulfill({status:200,contentType:u.pathname==='/'?'text/html':'text/javascript',body:fs.readFileSync(path.join(ROOT,u.pathname==='/'?'page.html':u.pathname.slice(1)))});
   if(u.pathname==='/health')return route.fulfill({json:{ok:true,version:'2.0.0',chatModel:'deepseek-ai/DeepSeek-V4.1-Flash',voiceId:'voc_rn489h83rcvs',tts:{sampleRate:24000}}});
   if(u.pathname==='/chat'){calls++;if(delay)await new Promise(r=>setTimeout(r,delay));return route.fulfill({contentType:'text/plain;charset=utf-8',body:'嗯，我在听。今天辛苦了，先坐下来歇一会儿，慢慢说给我听。'});}
   if(u.pathname==='/ttsstream'){
     ttsCalls++;if(breakNext){breakNext=false;return route.fulfill({status:502,body:'upstream error'});}
     const pcm=Buffer.alloc(24000*2*.7);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(Math.sin(i/24000*Math.PI*2*220)*3000),i*2);
     return route.fulfill({contentType:'application/octet-stream',body:pcm});
   }
   return route.fulfill({status:404});
 });
 await page.goto('http://127.0.0.1:3457/');
 await page.waitForFunction(()=>document.body.dataset.state==='idle');
 assert.equal(await page.locator('#eq').count(),0,'no EQ control');
 assert.equal(await page.locator('#talk').getAttribute('aria-label'),'开始语音对话');
 await fs.promises.mkdir('/sdcard/Download/DSH-Go/voice-design',{recursive:true});
 await page.screenshot({path:'/sdcard/Download/DSH-Go/voice-design/voice-idle.png'});
 await page.click('#kbBtn');await page.fill('#txt','今天想聊点什么');await page.click('#send');
 await page.waitForFunction(()=>document.body.dataset.state==='muted',{timeout:20000});
 assert.equal(calls,1);assert.ok(ttsCalls>0);
 assert.match(await page.locator('#log').textContent(),/今天辛苦了/);
 await page.screenshot({path:'/sdcard/Download/DSH-Go/voice-design/voice-conversation.png'});
 await page.click('#transcriptBtn');assert.equal(await page.locator('body').getAttribute('data-transcript'),'hidden');
 assert.equal(await page.locator('#log').isVisible(),false);assert.equal(await page.locator('#liveCaption').isVisible(),true);
 await page.click('#speakerBtn');assert.equal(await page.locator('#speakerBtn').getAttribute('aria-pressed'),'true');
 await page.click('#speakerBtn');
 await page.click('#talk');await page.waitForFunction(()=>document.body.dataset.state==='listening');
 await page.click('#talk');await page.waitForFunction(()=>document.body.dataset.state==='muted');
 // Hangup must invalidate a late LLM reply.
 delay=1000;await page.fill('#txt','取消这个请求');await page.click('#send');await page.waitForFunction(()=>document.body.dataset.state==='generating');await page.click('#hangup');
 await page.waitForTimeout(1500);assert.equal(await page.locator('body').getAttribute('data-state'),'ended');
 // Audio failure must surface, not fake speaking forever.
 delay=0;breakNext=true;await page.fill('#txt','错误测试');await page.click('#send');
 await page.waitForFunction(()=>document.body.dataset.state==='error',{timeout:15000});
 assert.ok(await page.locator('#errorRetry').isVisible());
 await page.click('#hangup');
 for(const size of [{width:320,height:640},{width:393,height:430},{width:768,height:1024}]){
   await page.setViewportSize(size);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,'no horizontal overflow '+JSON.stringify(size));
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['no EQ','text-only session','PCM AudioWorklet playback','captions at playback','transcript toggle','speaker mute','microphone mute/unmute','cancel late LLM','TTS error','responsive 320/393/768'],calls,ttsCalls,errors},null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
