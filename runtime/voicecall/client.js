'use strict';
(() => {
  const $ = id => document.getElementById(id);
  // Fixed DSP. No user-facing EQ; these values can later be replaced by acoustic tuning.
  // Fixed voice shaping (no user EQ). Warm body, tame the 2-3kHz harshness and
  // 5k sibilance that made the voice feel thin/high; slight downward pitch via
  // resampling gives a calmer, lower register without granular artifacts.
  const DSP = Object.freeze({hp:85, lowHz:180, low:2.5, midHz:340, mid:-1.0, presHz:2800, pres:-1.2, highHz:5200, high:-1.5, volume:.92, pitch:1});
  // Bigger first/later chunks keep most replies in one synthesis request, which
  // removes the per-request room/echo drift; long replies still stream in blocks.
  // Low-latency first block stays small; seams get a short shared-gain match and a
  // brief pause so consecutive requests join without a click or volume jump.
  const TUNE = Object.freeze({firstMin:20, firstMax:40, chunkMin:36, chunkMax:48,
    targetRms:.1, maxBoost:4, fadeMs:20, seamFadeMs:6, fetchAhead:2, maxQueuedSeconds:20, maxSegmentSeconds:24, startupMs:500, tailHoldMs:50, pauseMs:200, bargeFloor:0.12, bargeFactor:1.7, bargeFrames:6, cooldownMs:700});
  let ctx, sink, mic, micNode, micSource, micSilence, outputGain;
  let initialized=false, connecting=false, micMuted=false, speakerMuted=false;
  let lifecycle=null, lifecycleGeneration=0, micOpening=null;
  function currentCall(call,audio=ctx){return lifecycle===call&&call?.generation===lifecycleGeneration&&!call.abort.signal.aborted&&!document.hidden&&ctx===audio;}
  function checkCall(call,audio=ctx){if(!currentCall(call,audio))throw new DOMException('Aborted','AbortError');}
  function stopTracks(stream){for(const track of stream?.getTracks()||[])track.stop();}
  let epoch=0, turn=null, phase='idle', elapsedStart=0, config=null, timer=null;
  const sessions=[];
  const diagnostics=[];
  const rid=()=>{try{return crypto.randomUUID().replaceAll('-','');}catch{return Math.random().toString(16).slice(2)+Date.now().toString(16);}};
  const logPageId='p_'+rid();
  let logTurnId='',logRequestSequence=0,logSending=false,logTimer=null,heartbeat=null;
  const logPending=[];
  const logBadge=document.createElement('button');logBadge.type='button';logBadge.textContent='日志已开启';
  logBadge.title='复制最近阶段日志编号';logBadge.style.cssText='position:fixed;right:12px;top:86px;z-index:20;border:1px solid #ffffff25;border-radius:20px;background:#24242b;color:#bcb8c6;padding:6px 10px;font:11px system-ui';
  document.body.append(logBadge);
  async function flushLogs(){
    if(logSending||!logPending.length)return;
    logSending=true;const batch=logPending.splice(0,30);
    try{
      const response=await fetch('/diagnostics',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:batch}),keepalive:true,signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw new Error('log unavailable');
      logBadge.textContent=phase==='error'?'日志已记录 · 出错':'日志已开启';
    }catch{logBadge.textContent='日志暂存本页';}
    finally{logSending=false;if(logPending.length)logTimer=setTimeout(flushLogs,500);}
  }
  function trace(kind,values={}){
    const entry={kind,at:performance.now(),wallTime:new Date().toISOString(),pageId:logPageId,turnId:logTurnId,...values};
    diagnostics.push(entry);if(diagnostics.length>240)diagnostics.shift();
    logPending.push(entry);if(logPending.length>120)logPending.shift();
    if(!logTimer){logTimer=setTimeout(()=>{logTimer=null;flushLogs();},250);}
  }
  logBadge.addEventListener('click',()=>{
    const last=diagnostics.at(-1);logBadge.textContent='末阶段：'+(last?.kind||'ready');
    navigator.clipboard?.writeText(JSON.stringify({pageId:logPageId,events:diagnostics.slice(-30)},null,2)).catch(()=>{});
  });
  Object.defineProperty(window,'voiceDiagnostics',{get:()=>diagnostics.map(x=>({...x}))});
  let voiceProfile=null;try{const raw=localStorage.getItem('dsh_voiceprint_v1');if(raw)voiceProfile=JSON.parse(raw);}catch{}
  let voiceprintEnabled=!!voiceProfile,vpBusy=false;
  let voiceprintMode='loose';try{voiceprintMode=localStorage.getItem('dsh_vp_mode')||'loose';}catch{}
  function vpLabel(){if(!voiceProfile)return '声纹：点击录入';if(!voiceprintEnabled)return '声纹：已关闭';return '声纹：防噪音';}
  function setVpMode(m){voiceprintMode=m;try{localStorage.setItem('dsh_vp_mode',m);}catch{}vpBtn.textContent=vpLabel();vpBtn.dataset.on=voiceprintEnabled?'1':'';}

  // ---- Local voiceprint gate: only respond to the enrolled speaker's voice ----
  // Lightweight spectral-shape + pitch profile computed on-device; stores a small
  // numeric fingerprint (no raw audio). Not bank-grade verification, but rejects
  // other pitches / broadband noise / TV well enough for a hands-free gate.
  function _fftMag(frame){
    const n=frame.length,re=new Float32Array(n),im=new Float32Array(n);
    for(let i=0;i<n;i++){const w=0.5-0.5*Math.cos(2*Math.PI*i/(n-1));re[i]=frame[i]*w;}
    for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){const t=re[i];re[i]=re[j];re[j]=t;}}
    for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang);
      for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const ur=re[i+k],ui=im[i+k],jr=i+k+len/2;
        const vr=re[jr]*cr-im[jr]*ci,vi=re[jr]*ci+im[jr]*cr;
        re[i+k]=ur+vr;im[i+k]=ui+vi;re[jr]=ur-vr;im[jr]=ui-vi;
        const ncr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=ncr;}}}
    const mag=new Float32Array(n/2);for(let i=0;i<n/2;i++)mag[i]=re[i]*re[i]+im[i]*im[i];return mag;
  }
  const _BANDS=16,_EDGES=(sr=>{const hi=Math.min(7600,sr/2-200),lo=100,e=[];for(let i=0;i<=_BANDS;i++)e.push(lo*Math.pow(hi/lo,i/_BANDS));return e;});
  function _framePitch(seg,sr){
    let m=0;for(const x of seg)m+=x;m/=seg.length;const d=new Float32Array(seg.length);let e=0;
    for(let i=0;i<seg.length;i++){d[i]=seg[i]-m;e+=d[i]*d[i];}
    if(e/seg.length<1e-4)return 0;
    const minLag=Math.floor(sr/400),maxLag=Math.floor(sr/70);let best=0,bestV=-1;
    for(let lag=minLag;lag<=maxLag;lag++){let s=0;for(let i=0;i+lag<d.length;i++)s+=d[i]*d[i+lag];s/= (d.length-lag);if(s>bestV){bestV=s;best=lag;}}
    return best?sr/best:0;
  }
  function computeVoiceFeatures(pcm,sr){
    const fl=1024,hop=512,edges=_EDGES(sr),bands=new Float32Array(_BANDS);
    let frames=0,pitches=[],centroids=[],voicedSec=0;
    for(let pos=0;pos+fl<=pcm.length;pos+=hop){
      let e=0;for(let i=0;i<fl;i++)e+=pcm[pos+i]*pcm[pos+i];
      if(Math.sqrt(e/fl)<0.012)continue;
      const seg=pcm.subarray(pos,pos+fl),mag=_fftMag(seg);
      const binHz=(sr/2)/mag.length;let sumP=0,sumC=0;
      for(let b=0;b<_BANDS;b++){
        const lo=Math.max(1,Math.floor(edges[b]/binHz)),hi=Math.min(mag.length,Math.ceil(edges[b+1]/binHz));
        let p=0;for(let k=lo;k<hi;k++)p+=mag[k];
        bands[b]+=Math.log10(p+1e-9);
      }
      for(let k=1;k<mag.length;k++){sumP+=mag[k];sumC+=mag[k]*k*binHz;}
      centroids.push(sumP>0?sumC/sumP:0);
      const pi=_framePitch(seg,sr);if(pi>70&&pi<400)pitches.push(pi);
      frames++;voicedSec+=hop/sr;
    }
    if(frames<2)return null;
    for(let b=0;b<_BANDS;b++)bands[b]/=frames;
    let mean=0;for(const v of bands)mean+=v;mean/=_BANDS;
    const shape=new Float32Array(_BANDS);let norm=0;
    for(let b=0;b<_BANDS;b++){shape[b]=bands[b]-mean;norm+=shape[b]*shape[b];}
    norm=Math.sqrt(norm)||1;for(let b=0;b<_BANDS;b++)shape[b]/=norm;
    const pitch=pitches.length?pitches.slice().sort((a,b)=>a-b)[pitches.length>>1]:0;
    const centroid=centroids.length?centroids.reduce((a,b)=>a+b,0)/centroids.length:0;
    return {shape,pitch,centroid,frames,voicedSec};
  }
  function _cos(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;}
  function voiceprintScore(profile,feat){
    if(!profile||!feat)return 0;
    const cs=Math.max(0,Math.min(1,_cos(profile.shape,feat.shape)));
    const dp=profile.pitch&&feat.pitch?Math.abs(profile.pitch-feat.pitch):999;
    const ps=Math.exp(-Math.pow(dp/32,2));
    return 0.78*cs+0.22*ps;
  }
  function enrollFromBuffer(pcm,sr){
    const win=Math.floor(sr*0.8),hop=Math.floor(sr*0.4);let feats=[];
    for(let pos=0;pos+win<=pcm.length;pos+=hop){const f=computeVoiceFeatures(pcm.subarray(pos,pos+win),sr);if(f&&f.frames>=8)feats.push(f);}
    if(feats.length<2)return null;
    const meanOf=arrs=>{const s=new Float32Array(_BANDS);for(const a of arrs)for(let i=0;i<_BANDS;i++)s[i]+=a[i];let n=0;for(let i=0;i<_BANDS;i++){s[i]/=arrs.length;n+=s[i]*s[i];}n=Math.sqrt(n)||1;for(let i=0;i<_BANDS;i++)s[i]/=n;return s;};
    let shapes=feats.map(f=>f.shape);
    let mean=meanOf(shapes);
    // One robust pass: drop breath/transition outlier windows before averaging.
    let sims=shapes.map(s=>Math.max(0,_cos(s,mean)));
    const avg=sims.reduce((a,b)=>a+b,0)/sims.length;
    const sd=Math.sqrt(sims.reduce((a,b)=>a+(b-avg)*(b-avg),0)/sims.length);
    const keep=sims.map((v,i)=>({v,i})).filter(o=>o.v>=Math.max(0.35,avg-1.5*sd)).map(o=>o.i);
    if(keep.length>=2){shapes=keep.map(i=>shapes[i]);feats=keep.map(i=>feats[i]);mean=meanOf(shapes);sims=shapes.map(s=>Math.max(0,_cos(s,mean)));}
    const meanSim=sims.reduce((a,b)=>a+b,0)/sims.length;
    const minSim=Math.min.apply(null,sims);
    const ps=feats.map(f=>f.pitch).filter(v=>v>70&&v<400).sort((x,y)=>x-y);
    const pitch=ps.length?ps[ps.length>>1]:0;
    const threshold=Math.max(0.45,Math.min(0.8,meanSim*0.72));
    return {shape:mean,pitch,threshold,frames:feats.length,meanSim,minSim};
  }
  function verifyVoice(pcm,sr=ctx?.sampleRate||48000){
    if(!voiceprintEnabled||!voiceProfile)return true;
    const cap=Math.min(pcm.length,Math.floor(sr*6));            // first 6s is plenty for identity
    const use=pcm.subarray(0,cap);
    const ds=(sr!==16000)?resample(use,sr,16000):use;           // 16k keeps check cheap on device
    const f=computeVoiceFeatures(ds,16000);if(!f)return false;
    if(f.voicedSec<0.25)return false;
    const score=voiceprintScore(voiceProfile,f);
    trace('voiceprint-check',{score:Number(score.toFixed(3)),threshold:Number((voiceProfile.threshold||0).toFixed(3)),verdict:score>=(voiceProfile.threshold||0)?'accept':'reject'});
    return score>=(voiceProfile.threshold||0);
  }
  const VP_SERVICE='http://127.0.0.1:3459';
  function _cosArr(a,b){let d=0,na=0,nb=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}return d/((Math.sqrt(na)*Math.sqrt(nb))||1);}
  async function embedViaModel(samples,sr){
    try{
      const cap=Math.min(samples.length,Math.floor(sr*8));
      const r=await fetch(VP_SERVICE+'/embed',{method:'POST',headers:{'content-type':'audio/wav'},body:wavAt(samples.subarray(0,cap),sr),signal:AbortSignal.timeout(4000)});
      if(!r.ok)return null;const j=await r.json();
      return Array.isArray(j.embedding)?Float32Array.from(j.embedding):null;
    }catch{return null;}
  }
  async function enrollProfile(samples,sr){
    const heur=enrollFromBuffer(resample(samples,sr,16000),16000); // always build fallback shape
    try{
      const chunks=6,per=Math.floor(samples.length/chunks),embs=[];
      for(let i=0;i<chunks;i++){
        const part=samples.subarray(i*per,(i+1===chunks)?samples.length:(i+1)*per);
        if(part.length<sr*1.0)continue;
        const e=await embedViaModel(part,sr);if(e)embs.push(e);
      }
      if(embs.length>=2){
        const dim=embs[0].length,mean=new Float32Array(dim);
        for(const e of embs)for(let i=0;i<dim;i++)mean[i]+=e[i];
        let n=0;for(let i=0;i<dim;i++){mean[i]/=embs.length;n+=mean[i]*mean[i];}n=Math.sqrt(n)||1;for(let i=0;i<dim;i++)mean[i]/=n;
        let sum=0,sum2=0,cnt=0,mn=1;
        for(let i=0;i<embs.length;i++)for(let j=i+1;j<embs.length;j++){const c=_cosArr(embs[i],embs[j]);sum+=c;sum2+=c*c;cnt++;mn=Math.min(mn,c);}
        const meanSim=cnt?sum/cnt:0.8,sd=Math.sqrt(Math.max(0,(cnt?sum2/cnt:0)-meanSim*meanSim));
        const threshold=Math.max(0.42,Math.min(0.78,meanSim-2.6*sd));
        trace('voiceprint-model-enrolled',{takes:embs.length,meanSim:Number(meanSim.toFixed(3)),threshold:Number(threshold.toFixed(3))});
        return {model:1,emb:Array.from(mean),embs:embs.map(e=>Array.from(e)),threshold,frames:embs.length,meanSim,minSim:mn,pitch:heur?heur.pitch:0,shape:heur?heur.shape:null};
      }
    }catch{}
    return heur?{...heur,model:0}:null;
  }
  async function verifyVoiceAsync(pcm,sr=ctx?.sampleRate||48000){
    if(!voiceprintEnabled||!voiceProfile)return true;
    if(voiceProfile.model&&(voiceProfile.embs||voiceProfile.emb)){
      const emb=await embedViaModel(pcm,sr);
      if(emb){
        let score;
        if(voiceProfile.embs&&voiceProfile.embs.length){let mx=-1;for(const e of voiceProfile.embs){const c=_cosArr(e,emb);if(c>mx)mx=c;}score=mx;}
        else score=_cosArr(voiceProfile.emb,emb);
        const th=0.30; // 只做防噪音/挡明显他人，保证自己识别率
        trace('voiceprint-model',{score:Number(score.toFixed(3)),mode:voiceprintMode,threshold:Number(th.toFixed(3)),verdict:score>=th?'accept':'reject'});
        return score>=th;
      }
      trace('voiceprint-model-down');
    }
    return verifyVoice(pcm,sr);
  }
  function persistProfile(p){voiceProfile=p;try{if(p)localStorage.setItem('dsh_voiceprint_v1',JSON.stringify(p));else localStorage.removeItem('dsh_voiceprint_v1');}catch{}}
  const VP_PROMPTS=['你好呀，今天过得怎么样？','外面天气不错，适合出去走走。','我想听一首安静的歌。','帮我定个明早七点的闹钟。','有点累了，想早点休息。','晚安，明天见。'];
  const _sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function openVoiceprintEnroll(){
    if(vpBusy)return;
    const SEC=3200;
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(8,9,13,.74);display:flex;align-items:center;justify-content:center;padding:20px';
    const rows=VP_PROMPTS.map((t,i)=>`<div class="vpRow" data-i="${i}" style="display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border-radius:10px;color:#b6b3bf;font-size:15px;line-height:1.5;transition:background .2s,color .2s"><span class="vpDot" style="width:16px;flex:0 0 16px;text-align:center;color:#6f6c7a">○</span><span>${t}</span></div>`).join('');
    ov.innerHTML=`<div style="max-width:360px;width:100%;background:#20222a;border:1px solid #ffffff22;border-radius:20px;padding:20px;color:#ecebf0;font:14px/1.6 -apple-system,system-ui,sans-serif">
      <div style="font-size:16px;font-weight:600;margin-bottom:4px">录入你的声纹</div>
      <div style="color:#a9a7b3;margin-bottom:12px">跟着高亮的句子，一句一句念出来，读完一句等一下，大约 20 秒。</div>
      <div style="background:#171922;border:1px solid #ffffff14;border-radius:14px;padding:8px">${rows}</div>
      <div class="vpS" style="margin:14px 2px;color:#9a97a5;min-height:20px">准备就绪</div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="vpC" style="border:1px solid #ffffff26;background:transparent;color:#cfcbd8;border-radius:12px;padding:9px 16px">取消</button>
        <button class="vpGo" style="border:0;background:#7c6fd6;color:#fff;border-radius:12px;padding:9px 18px;font-weight:600">开始录入</button>
      </div></div>`;
    document.body.append(ov);
    const statusEl=ov.querySelector('.vpS'),goEl=ov.querySelector('.vpGo'),cancelEl=ov.querySelector('.vpC');
    const rowEls=[...ov.querySelectorAll('.vpRow')],dotEls=rowEls.map(r=>r.querySelector('.vpDot'));
    const mark=(i,state)=>{if(i<0||i>=rows.length)return;const r=rowEls[i],d=dotEls[i];if(state==='now'){r.style.background='#2b2a3a';r.style.color='#efeef4';d.textContent='●';d.style.color='#a99cf0';}else if(state==='done'){r.style.background='transparent';r.style.color='#8f8d99';d.textContent='✓';d.style.color='#7fae8e';}else{r.style.background='transparent';r.style.color='#b6b3bf';d.textContent='○';d.style.color='#6f6c7a';}};
    let stream,ac,src,proc;
    const cleanup=()=>{try{src&&src.disconnect();proc&&proc.disconnect();}catch{}try{stopTracks(stream);}catch{}try{ac&&ac.close();}catch{}};
    cancelEl.onclick=()=>{ov.remove();};
    goEl.onclick=async()=>{
      if(vpBusy)return;vpBusy=true;goEl.disabled=true;cancelEl.disabled=true;
      try{
        if(!navigator.mediaDevices?.getUserMedia){statusEl.textContent='这台设备没有可用的录音权限';vpBusy=false;goEl.disabled=false;cancelEl.disabled=false;return;}
        if(initialized){statusEl.textContent='请先挂断当前通话再录入声纹';vpBusy=false;goEl.disabled=false;cancelEl.disabled=false;return;}
        for(let c=3;c>0;c--){statusEl.textContent='准备… '+c;await _sleep(650);}
        stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
        ac=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});await ac.resume();
        src=ac.createMediaStreamSource(stream);proc=ac.createScriptProcessor(4096,1,1);
        const chunks=[];proc.onaudioprocess=e=>chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(proc);proc.connect(ac.destination);
        goEl.textContent='完成';goEl.disabled=false;cancelEl.disabled=false;
        let cancelled=false,idx=0;
        mark(0,'now');statusEl.textContent='第 1 / '+VP_PROMPTS.length+' 句，请开始念';
        await new Promise(res=>{
          const advance=()=>{mark(idx,'done');idx++;if(idx>=VP_PROMPTS.length){clearInterval(tick);res();return;}mark(idx,'now');statusEl.textContent='第 '+(idx+1)+' / '+VP_PROMPTS.length+' 句，请念这句';};
          const tick=setInterval(advance,SEC);
          goEl.onclick=()=>{clearInterval(tick);res();};
          cancelEl.onclick=()=>{cancelled=true;clearInterval(tick);res();};
        });
        cleanup();
        if(cancelled){ov.remove();return;}
        const total=chunks.reduce((a,c)=>a+c.length,0);
        if(total<48000*6){statusEl.textContent='录得太短啦，6 句尽量都念完再来一次';goEl.textContent='重新录入';goEl.style.display='';goEl.disabled=false;goEl.onclick=()=>{ov.remove();openVoiceprintEnroll();};cancelEl.style.display='';return;}
        statusEl.textContent='正在分析你的声纹…';goEl.style.display='none';cancelEl.style.display='none';
        const all=new Float32Array(total);let o=0;for(const c of chunks){all.set(c,o);o+=c.length;}
        const pr=await enrollProfile(all,48000);
        const tooFew=!pr||(pr.model?(pr.frames<3):(pr.frames<6))||pr.meanSim<0.5;
        if(tooFew){statusEl.textContent='这次录得不太完整'+(pr?('（一致度 '+(pr.meanSim*100|0)+'%）'):'')+'，把 6 句都念清楚再来一次';goEl.style.display='';goEl.textContent='重试';goEl.disabled=false;goEl.onclick=()=>{ov.remove();openVoiceprintEnroll();};cancelEl.style.display='';return;}
        persistProfile(pr);voiceprintEnabled=true;vpBtn.textContent=vpLabel();vpBtn.dataset.on='1';
        trace('voiceprint-enrolled',{frames:pr.frames,meanSim:Number(pr.meanSim.toFixed(3)),threshold:Number(pr.threshold.toFixed(3))});
        statusEl.textContent='录入成功！一致度 '+(pr.meanSim*100|0)+'%'+(pr.model?'（CAM++ 声纹）':'')+'，以后只回应你的声音。';
        goEl.style.display='none';cancelEl.textContent='好';cancelEl.disabled=false;cancelEl.onclick=()=>ov.remove();
        setTimeout(()=>{try{ov.remove();}catch{}},1800);
      }catch(e){trace('voiceprint-error',{errorName:e?.name||'Error'});statusEl.textContent='录入失败：'+(e?.name==='NotAllowedError'?'没有麦克风权限，请在系统设置里允许':'再试一次');goEl.style.display='';goEl.textContent='重试';goEl.disabled=false;goEl.onclick=()=>{ov.remove();openVoiceprintEnroll();};cancelEl.style.display='';}
      finally{vpBusy=false;cleanup();}
    };
  }
  function openVoiceMenu(){
    if(vpBusy)return;
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(8,9,13,.74);display:flex;align-items:flex-end;justify-content:center;padding:16px';
    const btn=(label,tone)=>`<button data-a="${tone}" style="width:100%;padding:13px;margin-top:8px;border-radius:12px;border:1px solid #ffffff20;background:${tone==='danger'?'#3a2026':'#24252d'};color:${tone==='danger'?'#e7a3a3':'#e7e5ee'};font-size:15px">${label}</button>`;
    ov.innerHTML=`<div style="max-width:360px;width:100%;background:#20222a;border:1px solid #ffffff22;border-radius:18px;padding:16px;color:#ecebf0;font:14px/1.6 -apple-system,system-ui,sans-serif">
      <div style="font-weight:600;margin-bottom:4px">声纹已录入</div>
      <div style="color:#a9a7b3;margin-bottom:6px">当前状态：${voiceprintEnabled?'防噪音（只挡杂音和明显他人）':'已关闭（会回应所有声音）'}</div>
      ${btn('重新录入','primary')}${btn(voiceprintEnabled?'暂时关闭':'重新开启','toggle')}${btn('删除声纹','danger')}${btn('取消','cancel')}
    </div>`;
    document.body.append(ov);
    ov.addEventListener('click',e=>{const a=e.target.closest('[data-a]');if(!a)return;const t=a.dataset.a;
      if(t==='primary'){ov.remove();openVoiceprintEnroll();}
      else if(t==='mode'){setVpMode(voiceprintMode==='strict'?'loose':'strict');ov.remove();}
      else if(t==='toggle'){voiceprintEnabled=!voiceprintEnabled;vpBtn.textContent=vpLabel();vpBtn.dataset.on=voiceprintEnabled?'1':'';ov.remove();}
      else if(t==='danger'){persistProfile(null);voiceprintEnabled=false;vpBtn.textContent='声纹：点击录入';vpBtn.dataset.on='';ov.remove();}
      else ov.remove();
    });
  }
  // Small injected control (test page only; the native module will own its own entry).
  const vpBtn=document.createElement('button');vpBtn.type='button';
  vpBtn.style.cssText='position:fixed;right:12px;top:118px;z-index:20;border:1px solid #ffffff25;border-radius:20px;background:#24242b;color:#cfcbd8;padding:6px 10px;font:11px system-ui';
  vpBtn.textContent=voiceProfile?(voiceprintEnabled?'声纹：防噪音':'声纹：已关闭'):'声纹：点击录入';
  if(voiceProfile)vpBtn.dataset.on='1';
  vpBtn.style.display='none';
  document.body.append(vpBtn);
  window.__vp={computeVoiceFeatures,voiceprintScore,enrollFromBuffer,verifyVoice,resample,embedViaModel,enrollProfile,verifyVoiceAsync,setProfile:p=>{persistProfile(p);voiceprintEnabled=!!p;},getProfile:()=>voiceProfile,setEnabled:v=>{voiceprintEnabled=v;},setMode:setVpMode,getMode:()=>voiceprintMode};

  const playback=new Map();
  let caption='', capture=[], lead=[], voiced=0, quiet=0, speakingFrames=0, raf=0, visualLevel=0, lastPlaybackLevel=0, cooldownUntil=0;
  const phoneIcon='<svg viewBox="0 0 24 24"><path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a15 15 0 0 1-7-7l2-2Z"/></svg>';
  const icons={mic:'<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>',
    muted:'<svg viewBox="0 0 24 24"><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v7M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3m-4 0h8"/></svg>'};

  function state(next, detail) {
    phase=next; document.body.dataset.state=next;trace('state',{phase:next});
    const names={idle:'想聊点什么？',connecting:'正在连接',listening:'我在听',recognizing:'听清你的话',generating:'想一想，马上回应',buffering:'正在准备声音',speaking:'正在说话',muted:'麦克风已静音',error:'连接遇到一点问题',ended:'这次，先聊到这里'};
    $('stageTitle').textContent=names[next]||names.idle;
    $('status').textContent=detail||({idle:'点一下麦克风，开始聊天',listening:'自然说话，停顿后我会回应',recognizing:'语音识别中',generating:'正在生成回答',buffering:'云端合成中，文字将随声音出现',speaking:'开口或轻点声纹，随时打断',muted:'仍然能听到回应，也可以打字',error:'可以重试，或切到文字输入',ended:'聊天记录留在本页，随时重新开始'}[next]||'请稍候…');
    const active=initialized;
    document.body.dataset.connected=String(active);
    $('net').textContent=active?'已连接':'未连接';
    if($('connectionBadge')) $('connectionBadge').dataset.connected=String(active);
    $('talk').disabled=connecting;
    $('talk').setAttribute('aria-label',!initialized?'开始语音对话':(micMuted?'取消麦克风静音':'静音麦克风'));
    $('talk').setAttribute('aria-pressed',String(initialized&&micMuted));
    const core=$('talk').querySelector('.core'); if(core) core.innerHTML=!initialized?phoneIcon:(micMuted?icons.muted:icons.mic);
    if($('muteLabel')) $('muteLabel').textContent=!initialized?'开始通话':(micMuted?'取消静音':'麦克风开');
    if($('micHint')) $('micHint').textContent=detail||({idle:'点下麦克风，自然说话就好。',connecting:'正在准备麦克风与语音连接',listening:'自然说话就好，不必按住按钮。',recognizing:'正在整理你刚才说的话',generating:'正在准备回复',buffering:'云端语音正在准备中',speaking:'想说话时，直接开口。',muted:'麦克风已静音，也可以打字给我。',error:'检查连接后重试，或先打字。',ended:'这段对话的字幕会留在这里。'}[next]||'');
    $('hangup').disabled=!initialized&&!connecting&&!turn;
    if($('errorRetry')) $('errorRetry').hidden=next!=='error';
  }
  function idleState(){ state(mic&& !micMuted?'listening':'muted'); }
  function message(text,who) {
    const d=document.createElement('div'); d.className='line '+who;
    const label=document.createElement('span'); label.className='line-label'; label.textContent=who==='user'?'你':'助手';
    const body=document.createElement('span'); body.className='line-content'; body.textContent=text;
    d.append(label,body); $('log').append(d); $('log').scrollTop=$('log').scrollHeight;
    return body;
  }
  function showCaption(text) {
    caption=text;
    const cap=$('liveCaption'); if(cap) cap.textContent=text;
    document.body.classList.toggle('has-caption',Boolean(text));
  }
  function level(n) {
    visualLevel=Math.max(0,Math.min(1,n));
    if(raf) return;
    raf=requestAnimationFrame(()=>{
      document.body.style.setProperty('--voice-level',visualLevel.toFixed(3));
      for(const [i,b] of [...$('wave').children].entries()) b.style.height=(4+visualLevel*(12+Math.sin(i*1.3)*8))+'px';
      raf=0;
    });
  }
  function clearCapture(){capture=[];lead=[];voiced=0;quiet=0;speakingFrames=0;}
  function alive(t){return t===turn&&!t.abort.signal.aborted&&t.epoch===epoch;}
  function cancelTurn(){
    trace('turn-cancel',{jobs:turn?.jobs||0,downloads:turn?.downloads||0,playbackCount:playback.size});
    epoch++;
    if(turn){
      // Preserve only completed audible segments when interrupted; never imply the queued tail was heard.
      if(turn.completedText&&!turn.committed)sessions.push({role:'assistant',content:turn.completedText});
      turn.abort.abort();
    }
    turn=null; playback.clear();
    if(sink) sink.reset(epoch);
    clearCapture(); level(0);
  }
  function interrupt(){cancelTurn(); if(initialized) idleState();}
  function softTtsFail(error) { if(error?.name==='AbortError') return;trace('tts-error',{errorName:error?.name||'Error',status:error?.status||0});flushLogs();console.error('[voice][tts]',error?.message);cancelTurn();state('idle','语音合成失败，稍后再试'); }
  function report(error) { if(error?.name==='AbortError') return;trace('client-error',{phase,errorName:error?.name||'Error',status:error?.status||0});flushLogs();console.error('[voice]',error?.message);state('error',error?.message||'连接暂时中断，请重试'); }
  function wait(t,ms){return new Promise((resolve,reject)=>{
    const onAbort=()=>{clearTimeout(id);reject(new DOMException('Aborted','AbortError'));};
    const id=setTimeout(()=>{t.abort.signal.removeEventListener('abort',onAbort);resolve();},ms);
    t.abort.signal.addEventListener('abort',onAbort,{once:true});
  });}
  async function request(path,options={},t){
    const timeout=AbortSignal.timeout(path==='/asr'?30000:45000);
    const signal=t?AbortSignal.any([timeout,t.abort.signal]):timeout;
    const requestId='r_'+(++logRequestSequence),stage=path.slice(1),started=performance.now();
    const headers=new Headers(options.headers||{});headers.set('x-voice-page-id',logPageId);headers.set('x-voice-turn-id',logTurnId||'none');headers.set('x-voice-request-id',requestId);
    trace(stage+'-start',{requestId,phase});
    let response;
    try{response=await fetch(path,{...options,headers,signal});trace(stage+'-headers',{requestId,status:response.status,elapsedMs:performance.now()-started});}
    catch(e){trace(stage+'-fetch-error',{requestId,errorName:e?.name||'Error',elapsedMs:performance.now()-started});if(t&&!alive(t))throw new DOMException('Aborted','AbortError');throw new Error('网络暂时没有响应，请重试');}
    if(!response.ok){
      const messages={429:'语音服务忙碌，请稍后重试',502:'云端语音暂时不可用，请重试',504:'云端响应超时，请重试'};
      const error=new Error(messages[response.status]||'服务返回异常（'+response.status+'）');
      if(response.status===429){const n=Number(response.headers.get('retry-after'));error.retryAfter=Number.isFinite(n)?Math.max(1,Math.min(300,n)):5;error.message+='，建议等待 '+error.retryAfter+' 秒';}
      error.status=response.status;throw error;
    }
    return response;
  }
  function post(body){return {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};}
  function updateClock(){if(!elapsedStart)return; const n=Math.floor((Date.now()-elapsedStart)/1000);$('sessionTime').textContent=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');}
  async function initAudio(call){
    checkCall(call);
    if(ctx){const audio=ctx;if(audio.state==='suspended')await audio.resume();checkCall(call,audio);return;}
    const audio=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});
    if(typeof audio.addEventListener==='function')audio.addEventListener('statechange',()=>trace('audio-context-state',{ctxState:audio.state}));
    ctx=audio;
    await audio.resume();checkCall(call,audio);
    const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=DSP.hp;hp.Q.value=.7;
    const low=ctx.createBiquadFilter();low.type='lowshelf';low.frequency.value=DSP.lowHz;low.gain.value=DSP.low;
    const mid=ctx.createBiquadFilter();mid.type='peaking';mid.frequency.value=DSP.midHz;mid.Q.value=1;mid.gain.value=DSP.mid;
    const pres=ctx.createBiquadFilter();pres.type='peaking';pres.frequency.value=DSP.presHz;pres.Q.value=.9;pres.gain.value=DSP.pres;
    const high=ctx.createBiquadFilter();high.type='highshelf';high.frequency.value=DSP.highHz;high.gain.value=DSP.high;
    const comp=ctx.createDynamicsCompressor();comp.threshold.value=-20;comp.knee.value=16;comp.ratio.value=2.6;comp.attack.value=.005;comp.release.value=.24;
    outputGain=ctx.createGain();outputGain.gain.value=speakerMuted?0:DSP.volume;
    hp.connect(low);low.connect(mid);mid.connect(pres);pres.connect(high);high.connect(comp);comp.connect(outputGain);outputGain.connect(ctx.destination);
    const consume=data=>{
      if(!currentCall(call,audio)||data.epoch!==epoch)return;
      const item=playback.get(data.id);
      if(data.type==='segment'&&item&&alive(item.turn)){
        item.turn.heard+=item.text;item.turn.body.textContent=item.turn.heard;showCaption(item.text);trace('audible-segment',{elapsedMs:performance.now()-item.turn.started});
        $('log').scrollTop=$('log').scrollHeight;state('speaking');
      } else if(data.type==='overflow'||data.type==='drop') {
        if(item&&alive(item.turn)){
          const error=new Error(data.type==='overflow'?'语音缓冲已满，已停止本轮，请分段重试':'语音数据异常，已停止本轮，请重试');
          cancelTurn();report(error);
        }
      } else if(data.type==='segmentEnd') {
        trace('playback-segment-end',{segment:Number(String(data.id).split(':').at(-1))||0,playedFrames:turn?.playedFrames||0});
        if(item&&alive(item.turn))item.turn.completedText+=item.text;
        playback.delete(data.id);
      } else if(data.type==='stats') {
        if(turn&&alive(turn)){turn.bufferedSeconds=data.bufferedSeconds||0;turn.playedFrames=data.playedFrames||0;if(data.playing)turn.lastPlaybackAt=performance.now();}
      }
      else if(data.type==='level'){lastPlaybackLevel=data.value;if(phase==='speaking')level(data.value*8);}
      else if(data.type==='buffering'&&turn&&alive(turn)){
        trace('audio-buffering',{elapsedMs:performance.now()-turn.started,active:data.buffering,reason:data.reason});
        if(data.reason==='starvation'&&data.id){turn.deep.add(data.id);trace('deep-buffer',{id:data.id,segment:Number(String(data.id).split(':').at(-1))||0});}
        if(data.buffering)state('buffering');else if(data.reason==='ready')state('speaking');
      }
      else if(data.type==='empty'&&turn&&alive(turn)){lastPlaybackLevel=0;if(!turn.finished||turn.jobs)state('buffering');}
    };
    try {
      await audio.audioWorklet.addModule('/pcm-worklet.js');checkCall(call,audio);
      const node=new AudioWorkletNode(audio,'voice-pcm');node.connect(low);node.port.onmessage=({data})=>consume(data);
      sink={push(pcm,id,t,final=true){node.port.postMessage({type:'push',pcm,id,epoch:t.epoch,stream:true,final},[pcm.buffer]);},reset(e){node.port.postMessage({type:'reset',epoch:e});},close(){node.disconnect();}};
    }catch(workletError){
      checkCall(call,audio);
      // Older WebViews: one continuous callback, not one AudioContext per chunk.
      let queue=[],offset=0,e=epoch,begunId=null,played=0;const node=ctx.createScriptProcessor(2048,0,1);node.connect(low);
      node.onaudioprocess=event=>{const out=event.outputBuffer.getChannelData(0);out.fill(0);let at=0;
        while(at<out.length&&queue.length){const item=queue[0];if(begunId!==item.id&&item.pcm.length){begunId=item.id;consume({type:'segment',id:item.id,epoch:e});}
          const n=Math.min(out.length-at,item.pcm.length-offset);out.set(item.pcm.subarray(offset,offset+n),at);at+=n;offset+=n;played+=n;
          if(offset===item.pcm.length){queue.shift();offset=0;if(item.final){consume({type:'segmentEnd',id:item.id,epoch:e});begunId=null;}if(!queue.length)consume({type:'empty',epoch:e});}}
        consume({type:'stats',playedFrames:played,bufferedSeconds:0,epoch:e});let sum=0;for(const x of out)sum+=x*x;if(at)level(Math.sqrt(sum/out.length)*8);
      };
      sink={push(pcm,id,t,final=true){queue.push({pcm,id,final});},reset(next){queue=[];offset=0;e=next;begunId=null;played=0;},close(){node.disconnect();}};
    }
    sink.reset(epoch);trace('audio-initialized',{ctxState:audio.state});
    if(!heartbeat)heartbeat=setInterval(()=>{
      if(!lifecycle&&!turn)return;
      trace('heartbeat',{phase,ctxState:ctx?.state||'closed',visibility:document.hidden?'hidden':'visible',jobs:turn?.jobs||0,downloads:turn?.downloads||0,playbackCount:playback.size,bufferedSeconds:turn?.bufferedSeconds||0,playedFrames:turn?.playedFrames||0,framesSent:turn?.framesSent||0,cdMs:Math.max(0,Math.round(cooldownUntil-performance.now()))});
      flushLogs();
    },1500);
  }
  async function connect(wantMic){
    if(connecting||document.hidden)return false;
    const call={generation:++lifecycleGeneration,abort:new AbortController()};lifecycle=call;
    connecting=true;state('connecting');
    try{
      await initAudio(call);checkCall(call);
      const signal=AbortSignal.any([AbortSignal.timeout(45000),call.abort.signal]);
      const res=await fetch('/health',{signal});checkCall(call);
      if(!res.ok)throw new Error('本机语音服务未就绪');
      const nextConfig=await res.json();checkCall(call);
      if(!nextConfig.ok)throw new Error('本机语音服务未就绪');
      config=nextConfig;
      if(wantMic)await openMic(call);else micMuted=!mic;
      checkCall(call);initialized=true;
      if(!elapsedStart){elapsedStart=Date.now();timer=setInterval(updateClock,1000);updateClock();}
      connecting=false;idleState();return true;
    }catch(e){if(lifecycle===call){stop();if(e?.name!=='AbortError')report(e);}return false;}
    finally{if(lifecycle===call){connecting=false;$('talk').disabled=false;}}
  }
  async function openMic(call=lifecycle){
    const audio=ctx;checkCall(call,audio);
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('此页面尚未获得录音能力，可先使用打字');
    if(micOpening?.call===call)return micOpening.promise;
    const operation={call,promise:null};micOpening=operation;
    operation.promise=(async()=>{
      let stream=null,source=null,node=null,silence=null;
      try{
        if(!mic){
          trace('microphone-permission-start');
          stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
          checkCall(call,audio);trace('microphone-ready');
          source=audio.createMediaStreamSource(stream);node=audio.createScriptProcessor(1024,1,1);silence=audio.createGain();silence.gain.value=0;
          node.onaudioprocess=e=>{if(currentCall(call,audio))onMic(e.inputBuffer.getChannelData(0));};
          source.connect(node);node.connect(silence);silence.connect(audio.destination);
          mic=stream;micSource=source;micNode=node;micSilence=silence;
        }
        checkCall(call,audio);micMuted=false;for(const track of mic.getTracks())track.enabled=true;
      }catch(e){
        stopTracks(stream);for(const resource of [node,source,silence])try{resource?.disconnect();}catch{}
        throw e;
      }finally{if(micOpening===operation)micOpening=null;}
    })();
    return operation.promise;
  }
  async function toggleMic(){
    if(connecting||micOpening?.call===lifecycle)return;
    if(!initialized){await connect(true);return;}
    const call=lifecycle;
    if(ctx?.state==='suspended'){
      try{const audio=ctx;await audio.resume();checkCall(call,audio);state(turn?phase:(micMuted?'muted':'listening'));}catch(e){if(lifecycle===call)report(e);}
      return;
    }
    if(!mic||micMuted){try{await openMic(call);checkCall(call);if(!turn)idleState();else state(phase);}catch(e){if(lifecycle===call){stop();if(e?.name!=='AbortError')report(e);}}return;}
    micMuted=true;for(const track of mic.getTracks())track.enabled=false;clearCapture();
    if(!turn)idleState();else state(phase);
  }
  function resample(input,from,to){
    if(from===to)return input;
    const n=Math.floor(input.length*to/from),out=new Float32Array(n),ratio=from/to;
    for(let i=0;i<n;i++){const p=i*ratio,k=Math.floor(p),f=p-k;out[i]=(input[k]||0)*(1-f)+(input[Math.min(k+1,input.length-1)]||0)*f;}
    return out;
  }
  function wavAt(input,from){
    const pcm=resample(input,from,16000),buffer=new ArrayBuffer(44+pcm.length*2),v=new DataView(buffer);
    const text=(p,str)=>[...str].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)));
    text(0,'RIFF');v.setUint32(4,36+pcm.length*2,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,pcm.length*2,true);
    pcm.forEach((x,i)=>v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,x))*32767),true));return buffer;
  }
  function wav(input){
    const pcm=resample(input,ctx.sampleRate,16000),buffer=new ArrayBuffer(44+pcm.length*2),v=new DataView(buffer);
    const text=(p,s)=>[...s].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)));
    text(0,'RIFF');v.setUint32(4,36+pcm.length*2,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,pcm.length*2,true);
    pcm.forEach((x,i)=>v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,x))*32767),true));return buffer;
  }
  function join(parts){const n=parts.reduce((a,p)=>a+p.length,0),out=new Float32Array(n);let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;}
  function onMic(input){
    if(micMuted||!initialized)return;
    let sum=0;for(const x of input)sum+=x*x;const rms=Math.sqrt(sum/input.length),dt=input.length/ctx.sampleRate;
    if(!turn)level(rms*12);
    lead.push(input.slice());if(lead.length>8)lead.shift();
    if(turn){
      // Barge-in must clearly beat the speaker's own output; otherwise loudspeaker
      // echo gets mistaken for the user and cuts long replies mid-sentence.
      const gate=Math.max(TUNE.bargeFloor,(phase==='speaking'?lastPlaybackLevel:0)*TUNE.bargeFactor);
      if(rms>gate){speakingFrames++;if(speakingFrames>=TUNE.bargeFrames){const pre=lead.slice();trace('barge-in',{rms:Number(rms.toFixed(3)),gate:Number(gate.toFixed(3))});interrupt();capture=pre;voiced=pre.length*dt;}}
      else speakingFrames=0;
      return;
    }
    // Cool-down: right after a reply, a cough/stammer must not start a new turn.
    if(performance.now()<cooldownUntil){capture=[];voiced=0;quiet=0;return;}
    if(rms>.012){if(!capture.length)capture=lead.slice(0,-1);capture.push(input.slice());voiced+=dt;quiet=0;}
    else if(capture.length){capture.push(input.slice());quiet+=dt;}
    if(capture.length&&(quiet>.55||voiced>25)){
      const samples=join(capture),valid=voiced>.25;clearCapture();if(valid)runUtterance(samples).catch(report);
    }
  }
  function newTurn(){cancelTurn();logTurnId='t_'+epoch+'_'+rid().slice(0,12);trace('turn-start',{phase});const t={epoch,abort:new AbortController(),jobs:0,downloads:0,finished:false,chain:Promise.resolve(),heard:'',completedText:'',committed:false,deep:new Set(),body:null,next:0,bufferedSeconds:0,framesSent:0,playedFrames:0,lastPlaybackAt:performance.now(),started:performance.now()};turn=t;return t;}
  async function runUtterance(samples){
    if(!(await verifyVoiceAsync(samples,ctx?.sampleRate||48000))){trace('voiceprint-reject');idleState();return;}
    const t=newTurn();trace('capture-complete',{audioMs:samples.length/ctx.sampleRate*1000});state('recognizing');
    try{const r=await request('/asr',{method:'POST',headers:{'content-type':'audio/wav'},body:wav(samples)},t);const j=await r.json();if(!alive(t))return;
      trace('asr-complete',{chars:j.text?.trim().length||0,elapsedMs:performance.now()-t.started});if(!j.text?.trim()){turn=null;idleState();return;}await reply(j.text.trim(),t);
    }catch(e){if(alive(t)){cancelTurn();report(e);}}
  }
  // Moderate contextual blocks avoid repeatedly restarting the voice on '嗯，'.
  function splitPending(text,final,first){
    const min=first?TUNE.firstMin:TUNE.chunkMin,max=first?TUNE.firstMax:TUNE.chunkMax;
    if(final&&text.length<=max+8)return {part:text,rest:''};
    if(text.length<min)return {part:'',rest:text};
    const end=/[。！？!?；;\n]/g;let m,cut=0;
    while((m=end.exec(text))){if(m.index+1>=min&&m.index+1<=max){cut=m.index+1;break;}}
    if(!cut&&text.length>=max){const upto=text.slice(0,max);for(let i=upto.length-1;i>=min-1;i--)if(/[，,、\s]/.test(upto[i])){cut=i+1;break;}if(!cut)cut=max;}
    return {part:cut?text.slice(0,cut):'',rest:cut?text.slice(cut):text};
  }
  function polish(pcm){
    let sum=0,peak=0;for(const x of pcm)sum+=x*x;
    const rms=Math.sqrt(sum/Math.max(1,pcm.length)),g=rms>1e-4?Math.min(TUNE.maxBoost,TUNE.targetRms/rms):1;
    for(const x of pcm)peak=Math.max(peak,Math.abs(x*g));const gain=g/Math.max(1,peak/.94);
    for(let i=0;i<pcm.length;i++)pcm[i]*=gain;
    const n=Math.min(Math.round(24000*TUNE.fadeMs/1000),Math.floor(pcm.length/2));
    for(let i=0;i<n;i++){const w=.5*(1-Math.cos(Math.PI*i/n));pcm[i]*=w;pcm[pcm.length-1-i]*=w;}
    return pcm;
  }
  // Incremental PCM DSP. A short tail is held for a smooth EOF; no whole-response wait.
  // Resampler phase and the previous sample persist across arbitrary network boundaries.
  function createProgressiveDSP(outRate,shared=null,isFirst=true){
    let held=new Float32Array(0),carry=null,calibrated=false,gain=1,fadeAt=0;
    let sourceFrames=0,nextPosition=0,previous=0;
    const fadeFrames=Math.round(24000*(isFirst?TUNE.fadeMs:TUNE.seamFadeMs)/1000),holdFrames=Math.round(24000*TUNE.tailHoldMs/1000);
    const outFrames=Math.round(24000*TUNE.fadeMs/1000);
    function convert(input,final){
      const base=sourceFrames?sourceFrames-1:0;
      const data=sourceFrames?join([new Float32Array([previous]),input]):input;
      const last=base+data.length-1,ratio=(24000/outRate)*DSP.pitch,out=[];
      while(data.length&&(final?nextPosition<last+1:nextPosition<last)){
        const relative=nextPosition-base,k=Math.floor(relative),f=relative-k;
        out.push((data[k]||0)*(1-f)+(data[Math.min(k+1,data.length-1)]||0)*f);nextPosition+=ratio;
      }
      sourceFrames+=input.length;if(input.length)previous=input[input.length-1];
      return Float32Array.from(out);
    }
    function process(bytes,final=false){
      let raw=bytes;
      if(carry!==null){const m=new Uint8Array(raw.length+1);m[0]=carry;m.set(raw,1);raw=m;carry=null;}
      const even=raw.length&~1;if(even<raw.length)carry=raw[even];
      if(final&&carry!==null)throw new Error('语音数据不完整，请重试');
      const dv=new DataView(raw.buffer,raw.byteOffset,even),pcm=new Float32Array(even/2);
      for(let i=0;i<pcm.length;i++)pcm[i]=dv.getInt16(i*2,true)/32768;
      held=join([held,pcm]);
      // Calibrate once using the first 250ms; never pump gain at packet boundaries.
      if(!calibrated){
        if(!final&&held.length<6000)return new Float32Array(0);
        let sum=0,count=0,peak=0;for(const x of held){peak=Math.max(peak,Math.abs(x));if(Math.abs(x)>.003){sum+=x*x;count++;}}
        const rms=Math.sqrt(sum/Math.max(1,count));
        let target=rms>.003?Math.min(2,TUNE.targetRms/rms):1;target=Math.min(target,.94/Math.max(.001,peak));
        // Match loudness across segments, but never jump more than ±10% at a seam.
        const prev=shared&&shared.gain!=null?shared.gain:target;
        gain=Math.max(prev*0.9,Math.min(prev*1.1,target));gain=Math.max(0.5,Math.min(2,gain));
        if(shared)shared.gain=gain;calibrated=true;
      }
      const count=final?held.length:Math.max(0,held.length-holdFrames);
      if(!count)return new Float32Array(0);
      const emit=held.slice(0,count);held=held.slice(count);
      for(let i=0;i<emit.length;i++){
        const startWeight=fadeAt<fadeFrames?.5*(1-Math.cos(Math.PI*fadeAt/fadeFrames)):1;
        const endIndex=emit.length-1-i;
        const endWeight=final&&endIndex<outFrames?.5*(1-Math.cos(Math.PI*endIndex/outFrames)):1;
        emit[i]=Math.max(-.94,Math.min(.94,emit[i]*gain*startWeight*endWeight));fadeAt++;
      }
      return convert(emit,final);
    }
    return {process};
  }
  async function prepareSegment(text,t,index){
    while(alive(t)&&t.downloads>=TUNE.fetchAhead)await wait(t,20);
    if(!alive(t))throw new DOMException('Aborted','AbortError');
    t.downloads++;const started=performance.now();
    try{return {response:await request('/ttsstream',post({text}),t),started};}
    catch(error){t.downloads--;throw error;}
  }
  function enqueue(text,t){
    if(!text.trim())return;
    const index=t.next++;t.jobs++;trace('segment-scheduled',{segment:index,chars:text.length});
    const prepared=prepareSegment(text,t,index);
    prepared.catch(error=>{if(alive(t))softTtsFail(error);});
    t.chain=t.chain.then(async()=>{
      let held=false;
      try{
        const {response,started}=await prepared;held=true;if(!alive(t))return;
        t.voiceGain=t.voiceGain||{gain:null};
        const reader=response.body.getReader(),dsp=createProgressiveDSP(ctx.sampleRate,t.voiceGain,index===0);
        const id=t.epoch+':'+index;let bytes=0,first=null,pushed=0;const acc=[];
        playback.set(id,{text,turn:t,frames:0});
        const push=async(pcm,final)=>{
          if(!alive(t))throw new DOMException('Aborted','AbortError');
          while(alive(t)&&(t.framesSent-t.playedFrames+pcm.length)/ctx.sampleRate>TUNE.maxQueuedSeconds)await wait(t,30);
          if(!alive(t))throw new DOMException('Aborted','AbortError');
          const item=playback.get(id);if(item)item.frames+=pcm.length;
          const frames=pcm.length;t.framesSent+=frames;pushed+=frames;sink.push(pcm,id,t,final);
          if(pushed===frames||final)trace('pcm-push',{segment:index,elapsedMs:performance.now()-t.started,audioMs:frames/ctx.sampleRate*1000,final});
        };
        if(index)await push(new Float32Array(Math.round(TUNE.pauseMs/1000*ctx.sampleRate)),false);
        while(true){
          const {done,value}=await reader.read();if(done)break;
          if(!alive(t)){await reader.cancel();return;}
          if(first===null){first=performance.now();trace('tts-first-byte',{segment:index,elapsedMs:first-t.started,requestMs:first-started});}
          bytes+=value.length;
          if(bytes>24000*2*TUNE.maxSegmentSeconds){await reader.cancel();throw new Error('单段语音超出缓冲预算，已停止本轮');}
          const pcm=dsp.process(value,false);
          if(t.deep.has(id)){if(pcm.length)acc.push(pcm);}
          else if(pcm.length)await push(pcm,false);
        }
        if(bytes<2||bytes%2)throw new Error('语音数据不完整，请重试');
        const tailPcm=dsp.process(new Uint8Array(0),true);
        if(t.deep.has(id)){if(tailPcm.length)acc.push(tailPcm);const joined=acc.length?join(acc):new Float32Array(0);trace('deep-buffer-flush',{segment:index,audioMs:joined.length/ctx.sampleRate*1000});await push(joined,true);}
        else await push(tailPcm,true);
        trace('tts-ready',{segment:index,firstByteMs:first===null?null:first-started,totalMs:performance.now()-started,audioMs:bytes/48});
        trace('queued',{segment:index,elapsedMs:performance.now()-t.started,audioMs:pushed/ctx.sampleRate*1000});
      }finally{if(held)t.downloads--;}
    }).finally(()=>t.jobs--);
    t.chain.catch(error=>{if(alive(t))softTtsFail(error);});
  }
  // Assistant text chunks for one turn. When the app hosts this page it injects
  // window.DshVoiceAsk: the text goes into the CURRENT DSH session (same model,
  // memory, tools, approvals) and the reply streams back — never a private
  // chat/completions endpoint. A plain browser (no bridge) falls back to /chat.
  function bridgeChunks(text){
    const queue=[];let done=false,error=null,wake=null;
    const kick=()=>{const r=wake;wake=null;if(r)r();};
    window.__dshVoiceSink={
      onDelta:d=>{if(typeof d==='string'&&d)queue.push(d);kick();},
      onDone:()=>{done=true;kick();},
      onError:m=>{error=new Error(m||'语音回合失败，请重试');done=true;kick();},
      onBlocked:m=>{error=new Error(m||'这次操作需要你确认');done=true;kick();},
    };
    try{window.DshVoiceAsk(text);}catch(e){error=e;done=true;}
    return (async function*(){
      while(true){
        if(queue.length){yield queue.shift();continue;}
        if(error)throw error;
        if(done)return;
        await new Promise(r=>{wake=r;});
      }
    })();
  }
  async function reply(text,t){
    message(text,'user');sessions.push({role:'user',content:text});
    t.body=message('','ai');state('generating');showCaption('');
    const bridge=typeof window.DshVoiceAsk==='function';
    let pending='',full='',first=true,firstToken=true;
    trace('llm-reading',{via:bridge?'dsh-session':'chat-completions'});
    const drain=final=>{while(pending){const {part,rest}=splitPending(pending,final,first);if(!part)break;enqueue(part,t);pending=rest;first=false;}};
    if(bridge){
      for await(const chunk of bridgeChunks(text)){
        if(!alive(t))return;
        if(firstToken&&chunk){firstToken=false;trace('llm-first-token',{elapsedMs:performance.now()-t.started});}
        pending+=chunk;full+=chunk;trace('llm-progress',{chars:full.length,elapsedMs:performance.now()-t.started});drain(false);
      }
      drain(true);if(pending)enqueue(pending,t);
    }else{
      const r=await request('/chat',post({messages:sessions.slice(-12)}),t),reader=r.body.getReader(),decoder=new TextDecoder();
      while(true){const {done,value}=await reader.read();if(!alive(t)){await reader.cancel();return;}if(done)break;const chunk=decoder.decode(value,{stream:true});if(firstToken&&chunk){firstToken=false;trace('llm-first-token',{elapsedMs:performance.now()-t.started});}pending+=chunk;full+=chunk;trace('llm-progress',{chars:full.length,elapsedMs:performance.now()-t.started});drain(false);}
      const tail=decoder.decode();pending+=tail;full+=tail;drain(true);if(pending)enqueue(pending,t);
    }
    if(!full.trim())throw new Error('这次没有收到回答，请重试');
    trace('llm-end',{chars:full.length,elapsedMs:performance.now()-t.started});t.finished=true;await t.chain;trace('tts-all-queued',{playbackCount:playback.size,elapsedMs:performance.now()-t.started});
    while(alive(t)&&playback.size){
      if(ctx?.state==='suspended'){trace('audio-suspended');state('buffering','音频已暂停，点麦克风恢复播放');}
      if(performance.now()-t.lastPlaybackAt>30000)throw new Error('音频播放长时间无进展，请重新开始通话');
      await wait(t,40);
    }
    if(!alive(t))return;
    trace('turn-complete',{elapsedMs:performance.now()-t.started});cooldownUntil=performance.now()+TUNE.cooldownMs;flushLogs();t.committed=true;sessions.push({role:'assistant',content:full});if(sessions.length>24)sessions.splice(0,sessions.length-24);
    turn=null;level(0);idleState();
  }
  async function sendText(){
    const text=$('txt').value.trim();if(!text)return;
    if(!initialized&&!(await connect(false)))return;
    $('txt').value='';$('send').hidden=true;const t=newTurn();
    try{await reply(text,t);}catch(e){if(alive(t)){cancelTurn();report(e);}}
  }
  function stop(){
    lifecycleGeneration++;const oldCall=lifecycle;lifecycle=null;oldCall?.abort.abort();micOpening=null;
    trace('call-stop',{phase,visibility:document.hidden?'hidden':'visible'});cancelTurn();flushLogs();clearInterval(heartbeat);heartbeat=null;initialized=false;connecting=false;micMuted=true;elapsedStart=0;clearInterval(timer);timer=null;
    stopTracks(mic);mic=null;
    for(const node of [micNode,micSource,micSilence])try{node?.disconnect();}catch{}
    micNode=micSource=micSilence=null;sink?.close();sink=null;outputGain=null;
    const old=ctx;ctx=null;old?.close().catch(()=>{});state('ended');
  }
  let vpPress=null,vpLong=false;
  vpBtn.addEventListener('pointerdown',()=>{vpLong=false;vpPress=setTimeout(()=>{vpLong=true;if(voiceProfile){persistProfile(null);voiceprintEnabled=false;vpBtn.textContent='声纹：点击录入';vpBtn.dataset.on='';toast&&toast('已清除声纹');}vpPress=null;},700);});
  vpBtn.addEventListener('pointerup',()=>{if(vpPress){clearTimeout(vpPress);vpPress=null;}});
  vpBtn.addEventListener('pointerleave',()=>{if(vpPress){clearTimeout(vpPress);vpPress=null;}});
  vpBtn.addEventListener('click',()=>{if(vpLong){vpLong=false;return;}if(vpBusy)return;if(!voiceProfile){openVoiceprintEnroll();return;}openVoiceMenu();});
  $('talk').addEventListener('click',()=>toggleMic().catch(report));
  $('hangup').addEventListener('click',stop);
  $('send').addEventListener('click',()=>sendText().catch(report));
  $('txt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendText().catch(report);}});
  $('kbBtn').addEventListener('click',()=>{$('txt').focus();});
  $('txt').addEventListener('input',()=>{$('send').hidden=!$('txt').value.trim();});
  $('transcriptBtn')?.addEventListener('click',()=>{const visible=document.body.dataset.transcript==='hidden';document.body.dataset.transcript=visible?'visible':'hidden';$('transcriptBtn').setAttribute('aria-pressed',String(visible));});
  $('speakerBtn')?.addEventListener('click',()=>{speakerMuted=!speakerMuted;if(outputGain)outputGain.gain.setTargetAtTime(speakerMuted?0:DSP.volume,ctx.currentTime,.015);$('speakerBtn').setAttribute('aria-pressed',String(speakerMuted));$('speakerBtn').setAttribute('aria-label',speakerMuted?'开启扬声器':'静音扬声器');});
  $('stage')?.addEventListener('click',()=>{if(turn)interrupt();});
  $('errorRetry')?.addEventListener('click',()=>{if(initialized)idleState();else connect(false);});
  $('backBtn')?.addEventListener('click',()=>{stop();if(history.length>1)history.back();else state('ended','已结束通话，可使用 App 返回键回到聊天');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(lifecycle||connecting||micOpening)){stop();}});
  window.addEventListener('pagehide',stop);
  window.addEventListener('error',e=>{trace('window-error',{errorName:e.error?.name||'Error'});flushLogs();});
  window.addEventListener('unhandledrejection',e=>{if(e.reason?.name!=='AbortError')report(e.reason);});
  state('idle');
})();
