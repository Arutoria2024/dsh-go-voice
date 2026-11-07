// PCM is already resampled to this AudioContext's sampleRate by the client.
// Legacy pushes are complete segments. Stream pushes append ordered chunks to
// one segment slot; final:true (including zero PCM) closes it before the next id.
class VoicePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.maxQueueSegments = 64;
    this.queue = new Array(this.maxQueueSegments);
    this.head = 0; this.length = 0; this.offset = 0;
    this.epoch = 0; this.started = false;
    this.prebuffer = Math.round(sampleRate * .3);
    this.streamPrebuffer = Math.round(sampleRate * .5);
    this.maxBufferedFrames = Math.round(sampleRate * 25);
    this.levelInterval = Math.max(1, Math.round(sampleRate / 10));
    this.statsInterval = Math.max(1, Math.round(sampleRate / 4));
    this.clearCounters();
    this.port.onmessage = ({data}) => this.receive(data);
  }
  clearCounters() {
    this.buffered = 0; this.resident = 0;
    this.acceptedFrames = 0; this.playedFrames = 0; this.renderedFrames = 0;
    this.acceptedSegments = 0; this.completedSegments = 0;
    this.droppedFrames = 0; this.droppedSegments = 0;
    this.expectationKnown = false; this.underrunCount = 0; this.underrunFrames = 0;
    this.bufferingReason = null;
    this.levelFrames = 0; this.levelSum = 0; this.levelDirty = false; this.lastLevel = 0;
    this.statsFrames = 0; this.statsDirty = false;
  }
  stats() {
    this.port.postMessage({
      type:'stats', epoch:this.epoch, sampleRate,
      bufferedFrames:this.buffered, bufferedSeconds:this.buffered / sampleRate,
      residentFrames:this.resident, queueLength:this.length,
      maxBufferedFrames:this.maxBufferedFrames, maxQueueSegments:this.maxQueueSegments,
      prebufferMs:this.prebuffer / sampleRate * 1000,
      streamPrebufferMs:this.streamPrebuffer / sampleRate * 1000, playing:this.started,
      buffering:!!this.bufferingReason, bufferingReason:this.bufferingReason,
      acceptedFrames:this.acceptedFrames, playedFrames:this.playedFrames,
      renderedFrames:this.renderedFrames, silenceFrames:this.renderedFrames - this.playedFrames,
      acceptedSegments:this.acceptedSegments, completedSegments:this.completedSegments,
      droppedFrames:this.droppedFrames, droppedSegments:this.droppedSegments,
      expectationKnown:this.expectationKnown,
      underrunCount:this.expectationKnown ? this.underrunCount : null,
      underrunFrames:this.expectationKnown ? this.underrunFrames : null
    });
    this.statsDirty = false;
  }
  drop(data, reason, frames = 0, overflow = false) {
    // A late packet must not alter the new epoch's counters or revive playback.
    if (data.epoch === this.epoch) {
      this.droppedFrames += frames; this.droppedSegments++;
      this.statsDirty = true;
    }
    this.port.postMessage({
      type:overflow ? 'overflow' : 'drop', id:data.id, epoch:data.epoch,
      currentEpoch:this.epoch, reason, frames,
      bufferedFrames:this.buffered, bufferedSeconds:this.buffered / sampleRate,
      residentFrames:this.resident, queueLength:this.length,
      maxBufferedFrames:this.maxBufferedFrames, maxQueueSegments:this.maxQueueSegments
    });
  }
  buffering(reason, item) {
    if (this.bufferingReason === reason) return;
    this.bufferingReason = reason;
    if (reason === 'starvation') this.underrunCount++;
    this.statsDirty = true;
    this.port.postMessage({type:'buffering', buffering:!!reason,
      reason:reason || 'ready', id:item.id, epoch:this.epoch});
  }
  completeHead() {
    const item = this.queue[this.head];
    this.queue[this.head] = undefined;
    this.head = (this.head + 1) % this.maxQueueSegments; this.length--; this.offset = 0;
    this.completedSegments++; this.statsDirty = true;
    this.port.postMessage({type:'segmentEnd', id:item.id, epoch:this.epoch});
    if (this.bufferingReason) this.buffering(null, item);
    if (!this.length) {
      this.started = false;
      this.port.postMessage({type:'empty', epoch:this.epoch});
    }
  }
  receive(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'reset') {
      if (!Number.isSafeInteger(data.epoch) || data.epoch < this.epoch) {
        this.drop(data, 'stale-reset'); return;
      }
      this.queue.fill(undefined);
      this.head = 0; this.length = 0; this.offset = 0; this.started = false;
      this.epoch = data.epoch;
      this.clearCounters();
      this.port.postMessage({type:'level', value:0, epoch:this.epoch});
      this.stats();
    } else if (data.type === 'configure') {
      // Optional epoch protects asynchronous configuration; legacy callers omit it.
      if (data.epoch !== undefined && data.epoch !== this.epoch) return;
      if (Number.isFinite(data.prebufferMs) && data.prebufferMs >= 0) {
        this.prebuffer = Math.round(sampleRate * Math.min(30000, data.prebufferMs) / 1000);
        this.streamPrebuffer = this.prebuffer;
      }
      if (Number.isFinite(data.maxBufferedSeconds) && data.maxBufferedSeconds > 0)
        this.maxBufferedFrames = Math.max(1, Math.round(sampleRate * Math.min(30, data.maxBufferedSeconds)));
      // Lowering the limit preserves accepted audio; new pushes wait for space.
      this.stats();
    } else if (data.type === 'getStats') {
      if (data.epoch === undefined || data.epoch === this.epoch) this.stats();
    } else if (data.type === 'push') {
      if (data.epoch !== this.epoch) { this.drop(data, 'stale-epoch'); return; }
      const pcm = data.pcm, stream = data.stream === true;
      if (!(pcm instanceof Float32Array)) { this.drop(data, 'invalid-pcm'); return; }
      if (!pcm.length && !(stream && data.final === true)) { this.drop(data, 'empty-pcm'); return; }
      let item = this.length ? this.queue[(this.head + this.length - 1) % this.maxQueueSegments] : null;
      const append = item && item.stream && stream && item.id === data.id;
      if (append && item.final) { this.drop(data, 'segment-finalized', pcm.length); return; }
      if (!append && item && item.stream && !item.final) {
        this.drop(data, 'segment-not-final', pcm.length); return;
      }
      if (!append && stream) {
        for (let i = 0; i < this.length; i++) {
          if (this.queue[(this.head + i) % this.maxQueueSegments].id === data.id) {
            this.drop(data, 'segment-order', pcm.length); return;
          }
        }
      }
      // Retained memory includes the already-read portion of the current chunk.
      if (pcm.length && this.resident + pcm.length > this.maxBufferedFrames) {
        this.drop(data, 'buffer-limit', pcm.length, true); return;
      }
      if (!append && this.length === this.maxQueueSegments) {
        this.drop(data, 'queue-limit', pcm.length, true); return;
      }
      // Do not retain a large backing buffer hidden behind a small subarray.
      const owned = pcm.byteOffset || pcm.byteLength !== pcm.buffer.byteLength ? pcm.slice() : pcm;
      if (append) {
        if (owned.length) {
          if (!item.pcm) item.pcm = owned;
          else {
            const chunk = {pcm:owned, next:null};
            if (item.tail) item.tail.next = chunk;
            else item.next = chunk;
            item.tail = chunk;
          }
        }
        item.final = data.final === true;
      } else {
        item = {pcm:owned.length ? owned : null, next:null, tail:null,
          id:data.id, begun:false, stream, final:!stream || data.final === true};
        this.queue[(this.head + this.length) % this.maxQueueSegments] = item;
        this.length++; this.acceptedSegments++;
      }
      this.buffered += owned.length; this.resident += owned.length;
      this.acceptedFrames += owned.length;
      if (stream) this.expectationKnown = true;
      this.statsDirty = true;
      // EOF may arrive after the last audio quantum drained. Complete without
      // waiting for more PCM or a playback restart that would otherwise hang.
      if (item === this.queue[this.head] && item.final && !item.pcm) this.completeHead();
    }
  }
  process(inputs, outputs) {
    const channels = outputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels.length; i++) channels[i].fill(0);
    const out = channels[0];
    let at = 0, sum = 0;
    if (this.length && !this.started) {
      const item = this.queue[this.head];
      const target = item.stream ? this.streamPrebuffer : Math.min(this.prebuffer, item.pcm.length);
      if ((item.pcm && this.buffered >= target) || (item.stream && item.final)) {
        this.started = true;
        if (this.bufferingReason) this.buffering(null, item);
      } else if (item.stream && !this.bufferingReason) this.buffering('prebuffer', item);
    }
    while (at < out.length && this.length && this.started) {
      const item = this.queue[this.head];
      if (!item.pcm) {
        if (item.final) { this.completeHead(); continue; }
        break;
      }
      if (!item.begun) {
        item.begun = true;
        this.port.postMessage({type:'segment', id:item.id, epoch:this.epoch});
      }
      const count = Math.min(item.pcm.length - this.offset, out.length - at);
      // No shift(), subarray views, or per-quantum audio allocations on this path.
      for (let i = 0; i < count; i++) {
        const value = item.pcm[this.offset + i];
        const finite = Number.isFinite(value) ? value : 0;
        out[at + i] = finite; sum += finite * finite;
      }
      this.offset += count; this.buffered -= count; at += count;
      if (this.offset === item.pcm.length) {
        this.resident -= item.pcm.length; this.offset = 0;
        if (item.next) {
          item.pcm = item.next.pcm; item.next = item.next.next;
          if (!item.next) item.tail = null;
        } else item.pcm = null;
        if (!item.pcm && item.final) this.completeHead();
      }
    }
    const head = this.length ? this.queue[this.head] : null;
    if (head && head.stream && head.begun && !head.pcm && !head.final) {
      this.started = false;
      this.buffering('starvation', head);
    }
    if (this.bufferingReason === 'starvation') {
      this.underrunFrames += out.length - at; this.statsDirty = true;
    }
    this.playedFrames += at; this.renderedFrames += out.length;
    this.levelFrames += out.length; this.levelSum += sum;
    if (at) { this.levelDirty = true; this.statsDirty = true; }
    if (this.levelFrames >= this.levelInterval) {
      if (this.levelDirty || this.lastLevel !== 0) {
        this.lastLevel = Math.sqrt(this.levelSum / this.levelFrames);
        this.port.postMessage({type:'level', value:this.lastLevel, epoch:this.epoch});
      }
      this.levelFrames = 0; this.levelSum = 0; this.levelDirty = false;
    }
    this.statsFrames += out.length;
    if (this.statsFrames >= this.statsInterval) {
      this.statsFrames = 0;
      if (this.statsDirty) this.stats();
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePCM);
