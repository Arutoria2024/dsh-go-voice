'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production file. Only the browser's registration/port are stubbed.
const filename = path.join(__dirname, '..', 'pcm-worklet.js');
const source = fs.readFileSync(filename, 'utf8');
function harness(rate = 48000) {
  let Processor, frame = 0;
  const messages = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = {postMessage(data) { messages.push({...structuredClone(data), frame}); }};
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor, sampleRate:rate, Float32Array,
    registerProcessor(name, value) { assert.equal(name, 'voice-pcm'); Processor = value; }
  }, {filename});
  const processor = new Processor();
  const send = data => processor.port.onmessage({data:structuredClone(data)});
  const push = (pcm, id = 'a', epoch = 0) => send({type:'push', pcm, id, epoch});
  const stream = (pcm, id = 'a', final = false, epoch = 0) => send({type:'push', pcm, id, epoch, stream:true, final});
  const events = type => messages.filter(message => message.type === type);
  const quantum = (size = 128, channelCount = 1) => {
    const channels = Array.from({length:channelCount}, () => new Float32Array(size).fill(99));
    assert.equal(processor.process([], [channels]), true);
    frame += size;
    return channels;
  };
  const render = count => {
    const out = new Float32Array(count * 128);
    for (let i = 0; i < count; i++) out.set(quantum()[0], i * 128);
    return out;
  };
  const stats = () => { send({type:'getStats'}); return events('stats').at(-1); };
  return {processor, send, push, stream, quantum, render, events, messages, stats};
}
const constant = (length, value = .25) => new Float32Array(length).fill(value);
const segmentEvents = h => h.messages.filter(e => ['segment', 'segmentEnd', 'empty'].includes(e.type));

test('first sample plays immediately for a complete segment and notifications follow consumed frames', () => {
  const h = harness();
  const pcm = constant(300); pcm[0] = .75; pcm[299] = -.5;
  h.push(pcm, 'one');
  assert.equal(h.events('segment').length, 0);
  const first = h.quantum()[0];
  assert.equal(first[0], .75);
  assert.equal(h.events('segment')[0].frame, 0);
  assert.equal(h.events('segmentEnd').length, 0);
  h.quantum();
  const tail = h.quantum()[0];
  assert.equal(tail[43], -.5);
  assert.ok(tail.slice(44).every(x => x === 0));
  assert.deepEqual(segmentEvents(h).map(e => [e.type, e.id, e.epoch, e.frame]), [
    ['segment', 'one', 0, 0], ['segmentEnd', 'one', 0, 256], ['empty', undefined, 0, 256]
  ]);
  assert.equal(h.stats().playedFrames, 300);
  assert.equal(h.stats().renderedFrames, 384);
  assert.equal(h.stats().silenceFrames, 84);
});

test('segment boundaries are sample aligned inside one quantum without a gap', () => {
  const h = harness();
  h.push(constant(73, .5), 'first'); h.push(constant(80, -.25), 'second');
  const output = h.render(2);
  assert.ok(output.slice(0, 73).every(x => x === .5));
  assert.ok(output.slice(73, 153).every(x => x === -.25));
  assert.ok(output.slice(153).every(x => x === 0));
  assert.deepEqual(segmentEvents(h).map(e => [e.type, e.id]), [
    ['segment', 'first'], ['segmentEnd', 'first'], ['segment', 'second'], ['segmentEnd', 'second'], ['empty', undefined]
  ]);
});

test('short final segments never wait for the configured prebuffer', () => {
  const h = harness();
  h.send({type:'configure', prebufferMs:1000});
  h.push(constant(1, .625), 'tail');
  const out = h.quantum()[0];
  assert.equal(out[0], .625); assert.ok(out.slice(1).every(x => x === 0));
  h.render(50);
  assert.equal(h.events('empty').length, 1);
  assert.equal(h.events('segmentEnd').length, 1);
});

test('reset clears a partially consumed segment and late packets do not resurrect it', () => {
  const h = harness();
  h.push(constant(1000, .75), 'old'); h.quantum();
  h.send({type:'reset', epoch:1});
  h.push(constant(1000, -.75), 'late', 0);
  assert.ok(h.render(10).every(x => x === 0));
  assert.equal(h.events('segmentEnd').length, 0);
  assert.equal(h.events('drop').at(-1).reason, 'stale-epoch');
  assert.equal(h.events('drop').at(-1).epoch, 0);
  assert.equal(h.events('drop').at(-1).currentEpoch, 1);
  assert.equal(h.stats().playedFrames, 0);
  assert.equal(h.stats().droppedSegments, 0);
  assert.equal(h.stats().residentFrames, 0);
  h.push(constant(1, .125), 'new', 1);
  assert.equal(h.quantum()[0][0], .125);
  assert.equal(h.events('segment').at(-1).epoch, 1);
});

test('stale resets cannot roll the epoch back; equal epoch reset remains compatible', () => {
  const h = harness();
  h.send({type:'reset', epoch:4});
  h.push(constant(256), 'four', 4);
  h.send({type:'reset', epoch:3});
  assert.equal(h.stats().queueLength, 1);
  assert.equal(h.stats().epoch, 4);
  assert.equal(h.events('drop').at(-1).reason, 'stale-reset');
  h.send({type:'reset', epoch:4});
  assert.ok(h.render(2).every(x => x === 0));
  h.send({type:'reset', epoch:NaN});
  assert.equal(h.stats().epoch, 4);
});

test('a whole segment beyond the default 25 second budget is explicitly rejected', () => {
  const h = harness(8000);
  h.push(constant(8000 * 25 + 1), 'oversized');
  const overflow = h.events('overflow').at(-1);
  assert.equal(overflow.reason, 'buffer-limit');
  assert.equal(overflow.id, 'oversized'); assert.equal(overflow.epoch, 0);
  assert.equal(overflow.maxBufferedFrames, 200000);
  assert.equal(h.stats().queueLength, 0);
  assert.equal(h.stats().droppedFrames, 200001);
  assert.ok(h.render(2).every(x => x === 0));
  assert.equal(h.events('segment').length, 0);
});

test('buffer limit accounts for retained head memory until the segment completes', () => {
  const h = harness(8000);
  h.send({type:'configure', prebufferMs:0, maxBufferedSeconds:.1});
  h.push(constant(800), 'head'); h.render(6);
  let s = h.stats();
  assert.equal(s.bufferedFrames, 32); assert.equal(s.residentFrames, 800);
  h.push(constant(1), 'too-early');
  assert.equal(h.events('overflow').at(-1).reason, 'buffer-limit');
  h.quantum();
  h.push(constant(800), 'fits-now');
  s = h.stats(); assert.equal(s.residentFrames, 800); assert.equal(s.queueLength, 1);
});

test('64 segment bound and ring wrap preserve ordering over many cycles', () => {
  const h = harness();
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 64; i++) h.push(constant(1, (i + 1) / 128), `${round}:${i}`);
    h.push(constant(1), `overflow:${round}`);
    assert.equal(h.stats().queueLength, 64);
    assert.equal(h.events('overflow').at(-1).reason, 'queue-limit');
    const output = h.quantum()[0];
    for (let i = 0; i < 64; i++) assert.equal(output[i], (i + 1) / 128);
    assert.ok(output.slice(64).every(x => x === 0));
  }
  assert.equal(h.events('segmentEnd').length, 320);
  assert.equal(h.events('overflow').length, 5);
  assert.equal(h.stats().residentFrames, 0);
  assert.deepEqual(h.events('segmentEnd').map(e => e.id),
    Array.from({length:320}, (_, n) => `${Math.floor(n / 64)}:${n % 64}`));
});

test('zero length and invalid PCM report drop without segment events or blocking later audio', () => {
  const h = harness();
  h.push(new Float32Array(0), 'zero');
  h.push([.5], 'array'); h.push(null, 'null');
  assert.deepEqual(h.events('drop').map(e => e.reason), ['empty-pcm', 'invalid-pcm', 'invalid-pcm']);
  h.push(constant(1, -.5), 'valid');
  assert.equal(h.quantum()[0][0], -.5);
  assert.deepEqual(h.events('segment').map(e => e.id), ['valid']);
  assert.equal(h.stats().droppedSegments, 3);
});

test('all-zero PCM is still consumed as audio and completes its segment', () => {
  const h = harness();
  h.push(new Float32Array(129), 'silent');
  assert.ok(h.render(2).every(x => x === 0));
  assert.equal(h.events('drop').length, 0);
  assert.equal(h.events('segmentEnd').at(-1).id, 'silent');
  assert.equal(h.stats().playedFrames, 129);
  assert.equal(h.stats().silenceFrames, 127);
});

test('non-finite samples become silence and all samples and level values stay finite', () => {
  const h = harness(8000);
  h.push(new Float32Array([NaN, Infinity, -Infinity, .5]), 'finite');
  const output = h.render(20);
  assert.ok(output.every(Number.isFinite));
  assert.deepEqual(Array.from(output.slice(0, 4)), [0, 0, 0, .5]);
  assert.ok(h.events('level').length > 0);
  assert.ok(h.events('level').every(e => Number.isFinite(e.value)));
  assert.equal(h.stats().playedFrames, 4);
});

test('level is window RMS, throttled to at most 10 Hz, then settles to zero', () => {
  const h = harness(48000);
  h.push(constant(48000, .5));
  h.render(375);
  const levels = h.events('level');
  assert.ok(levels.length >= 9 && levels.length <= 10);
  assert.ok(levels.every(e => e.value === .5));
  const activeStats = h.events('stats');
  assert.ok(activeStats.length <= 4);
  h.render(100);
  assert.equal(h.events('level').at(-1).value, 0);
  const count = h.events('level').length;
  h.render(100);
  assert.equal(h.events('level').length, count);
});

test('stats count actual frame consumption, and empty never invents an underrun', () => {
  const h = harness(44100);
  h.render(2); h.push(constant(257)); h.render(3); h.render(2);
  const s = h.stats();
  assert.equal(s.sampleRate, 44100);
  assert.equal(s.playedFrames, 257); assert.equal(s.acceptedFrames, 257);
  assert.equal(s.renderedFrames, 7 * 128); assert.equal(s.silenceFrames, 7 * 128 - 257);
  assert.equal(s.bufferedFrames, 0); assert.equal(s.residentFrames, 0);
  assert.equal(s.acceptedSegments, 1); assert.equal(s.completedSegments, 1);
  assert.equal(s.expectationKnown, false);
  assert.equal(s.underrunCount, null); assert.equal(s.underrunFrames, null);
  assert.equal(h.events('empty').length, 1);
  assert.equal(h.events('underrun').length, 0);
});

test('configure caps limits, ignores invalid values, and never discards accepted segments', () => {
  const h = harness(8000);
  h.send({type:'configure', prebufferMs:45000, maxBufferedSeconds:50});
  assert.equal(h.stats().maxBufferedFrames, 240000);
  assert.equal(h.stats().prebufferMs, 30000);
  h.push(constant(1000), 'kept');
  h.send({type:'configure', prebufferMs:0, maxBufferedSeconds:.01});
  assert.equal(h.stats().queueLength, 1);
  h.send({type:'configure', prebufferMs:-1, maxBufferedSeconds:0});
  assert.equal(h.stats().maxBufferedFrames, 80); assert.equal(h.stats().prebufferMs, 0);
  h.send({type:'configure', epoch:8, maxBufferedSeconds:5});
  assert.equal(h.stats().maxBufferedFrames, 80);
  assert.ok(h.render(8).slice(0, 1000).every(x => x === .25));
  assert.equal(h.events('segmentEnd').at(-1).id, 'kept');
});

test('small subarray does not retain its oversized backing buffer', () => {
  const h = harness(8000);
  const large = new Float32Array(8000 * 60); large[100] = .375;
  h.push(large.subarray(100, 101));
  const retained = h.processor.queue[h.processor.head].pcm;
  assert.equal(retained.buffer.byteLength, 4);
  assert.equal(h.quantum()[0][0], .375);
});

test('all output channels clear and stop/reset leaves no residual samples', () => {
  const h = harness();
  h.push(constant(256, .75));
  const channels = h.quantum(128, 2);
  assert.ok(channels[0].every(x => x === .75));
  assert.ok(channels[1].every(x => x === 0));
  h.send({type:'reset', epoch:1});
  assert.ok(h.render(30).every(x => x === 0));
  assert.deepEqual(h.events('level').at(-1).value, 0);
  assert.equal(h.stats().bufferedFrames, 0);
  assert.equal(h.stats().queueLength, 0);
  assert.equal(h.events('empty').length, 0);
});

test('stream starts before EOF at 500ms and contiguous chunks share one subtitle lifecycle', () => {
  const h = harness(8000);
  h.stream(constant(1600, .25), 'sentence');
  h.stream(constant(1600, .5), 'sentence');
  assert.ok(h.render(4).every(x => x === 0));
  h.stream(constant(800, .75), 'sentence');
  assert.ok(h.quantum(1600)[0].every(x => x === .25));
  assert.equal(h.events('segment').length, 1);
  assert.equal(h.events('segmentEnd').length, 0);
  h.stream(constant(800, -.25), 'sentence', true);
  const rest = h.quantum(3200)[0];
  assert.ok(rest.slice(0, 1600).every(x => x === .5));
  assert.ok(rest.slice(1600, 2400).every(x => x === .75));
  assert.ok(rest.slice(2400).every(x => x === -.25));
  assert.deepEqual(segmentEvents(h).map(e => [e.type, e.id]), [
    ['segment', 'sentence'], ['segmentEnd', 'sentence'], ['empty', undefined]
  ]);
  const s = h.stats();
  assert.equal(s.acceptedSegments, 1); assert.equal(s.completedSegments, 1);
  assert.equal(s.acceptedFrames, 4800); assert.equal(s.playedFrames, 4800);
  assert.equal(s.underrunCount, 0); assert.equal(s.residentFrames, 0);
});

test('a 200ms network interruption below 500ms startup buffer does not play or report starvation', () => {
  const h = harness(8000);
  h.stream(constant(1600), 'waiting');
  assert.ok(h.quantum(1600)[0].every(x => x === 0));
  h.stream(constant(1600), 'waiting');
  assert.ok(h.quantum(1600)[0].every(x => x === 0));
  assert.equal(h.events('segment').length, 0);
  assert.equal(h.events('empty').length, 0);
  assert.equal(h.stats().underrunCount, 0);
  assert.equal(h.stats().underrunFrames, 0);
  assert.deepEqual(h.events('buffering').map(e => e.reason), ['prebuffer']);
  h.stream(constant(800), 'waiting');
  assert.equal(h.quantum()[0][0], .25);
  assert.equal(h.events('buffering').at(-1).buffering, false);
});

test('a finalized short stream bypasses prebuffer and ends only after its last sample', () => {
  const h = harness();
  h.stream(constant(30, .5), 'short');
  assert.ok(h.quantum()[0].every(x => x === 0));
  h.stream(constant(100, -.5), 'short', true);
  const first = h.quantum()[0];
  assert.ok(first.slice(0, 30).every(x => x === .5));
  assert.ok(first.slice(30).every(x => x === -.5));
  assert.equal(h.events('segmentEnd').length, 0);
  const last = h.quantum()[0];
  assert.deepEqual(Array.from(last.slice(0, 3)), [-.5, -.5, 0]);
  assert.equal(h.events('segment').length, 1);
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.stats().underrunCount, 0);
});

test('an unfinished stream stalls rather than ends, then waits for a full 500ms rebuffer', () => {
  const h = harness(8000);
  h.stream(constant(4000, .5), 'paused');
  assert.ok(h.quantum(4000)[0].every(x => x === .5));
  assert.equal(h.events('segmentEnd').length, 0);
  assert.equal(h.events('empty').length, 0);
  assert.equal(h.stats().queueLength, 1);
  assert.equal(h.stats().residentFrames, 0);
  assert.equal(h.stats().underrunCount, 1);
  assert.equal(h.stats().underrunFrames, 0);
  assert.ok(h.quantum(1600)[0].every(x => x === 0));
  h.stream(constant(1600, -.25), 'paused');
  assert.ok(h.quantum(1600)[0].every(x => x === 0));
  h.stream(constant(1600, -.25), 'paused');
  assert.ok(h.quantum(1600)[0].every(x => x === 0));
  assert.equal(h.stats().underrunCount, 1);
  assert.equal(h.stats().underrunFrames, 4800);
  h.stream(constant(800, -.25), 'paused');
  assert.ok(h.quantum(1000)[0].every(x => x === -.25));
  assert.equal(h.events('segment').length, 1);
  h.stream(new Float32Array(0), 'paused', true);
  assert.equal(h.events('segmentEnd').length, 0);
  assert.ok(h.quantum(3000)[0].every(x => x === -.25));
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.stats().underrunCount, 1);
  assert.deepEqual(h.events('buffering').map(e => [e.buffering, e.reason]), [
    [true, 'starvation'], [false, 'ready']
  ]);
});

test('final short tail bypasses the rebuffer threshold after a real stall', () => {
  const h = harness(8000);
  h.stream(constant(4000), 'tail'); h.quantum(4000);
  h.stream(constant(20, -.5), 'tail');
  assert.ok(h.quantum()[0].every(x => x === 0));
  h.stream(new Float32Array(0), 'tail', true);
  const out = h.quantum()[0];
  assert.ok(out.slice(0, 20).every(x => x === -.5));
  assert.ok(out.slice(20).every(x => x === 0));
  assert.equal(h.events('segment').length, 1);
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.events('empty').length, 1);
});

test('zero PCM EOF after audio has already drained completes immediately without hanging', () => {
  const h = harness(8000);
  h.stream(constant(4000), 'eof'); h.quantum(4000); h.quantum();
  assert.equal(h.events('segmentEnd').length, 0);
  h.stream(new Float32Array(0), 'eof', true);
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.events('empty').length, 1);
  assert.equal(h.stats().queueLength, 0);
  const underruns = h.stats().underrunFrames;
  h.render(20);
  assert.equal(h.stats().underrunFrames, underruns);
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.events('empty').length, 1);
});

test('zero-only final markers finish without invented segment start or starvation', () => {
  const h = harness();
  h.stream(new Float32Array(0), 'empty-final', true);
  assert.equal(h.events('segment').length, 0);
  assert.deepEqual(h.events('segmentEnd').map(e => e.id), ['empty-final']);
  assert.equal(h.stats().acceptedFrames, 0);
  assert.equal(h.stats().completedSegments, 1);
  h.render(5);
  assert.equal(h.stats().underrunCount, 0);
  assert.equal(h.stats().queueLength, 0);
});

test('more than 64 100ms chunks use one segment slot and preserve sample order', () => {
  const h = harness(8000);
  for (let i = 0; i < 100; i++) h.stream(constant(800, i / 128), 'long', i === 99);
  assert.equal(h.stats().queueLength, 1);
  assert.equal(h.stats().acceptedSegments, 1);
  assert.equal(h.events('overflow').length, 0);
  const out = h.quantum(80000)[0];
  for (let i = 0; i < 100; i++) assert.ok(out.slice(i * 800, (i + 1) * 800).every(x => x === i / 128));
  assert.equal(h.events('segment').length, 1);
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.stats().residentFrames, 0);
});

test('stream chunks obey the retained 25s memory limit, with explicit retryable overflow', () => {
  const h = harness(8000);
  for (let i = 0; i < 125; i++) h.stream(constant(1600), 'bounded');
  h.stream(constant(1), 'bounded', true);
  assert.equal(h.events('overflow').at(-1).reason, 'buffer-limit');
  assert.equal(h.stats().residentFrames, 200000);
  assert.equal(h.stats().queueLength, 1);
  h.quantum(1600);
  assert.equal(h.stats().residentFrames, 198400);
  h.stream(constant(1), 'bounded', true);
  h.quantum(198401);
  assert.equal(h.events('segmentEnd').length, 1);
  assert.equal(h.stats().acceptedFrames, 200001);
});

test('different stream ids cannot interleave or cross finalized queued segments', () => {
  const h = harness(8000);
  h.stream(constant(73, .5), 'first');
  h.stream(constant(1, .75), 'second');
  assert.equal(h.events('drop').at(-1).reason, 'segment-not-final');
  h.stream(new Float32Array(0), 'first', true);
  h.stream(constant(80, -.25), 'second', true);
  h.stream(constant(1), 'first');
  assert.equal(h.events('drop').at(-1).reason, 'segment-order');
  h.stream(constant(1), 'second');
  assert.equal(h.events('drop').at(-1).reason, 'segment-finalized');
  const out = h.quantum(153)[0];
  assert.ok(out.slice(0, 73).every(x => x === .5));
  assert.ok(out.slice(73).every(x => x === -.25));
  assert.deepEqual(segmentEvents(h).map(e => [e.type, e.id]), [
    ['segment', 'first'], ['segmentEnd', 'first'], ['segment', 'second'], ['segmentEnd', 'second'], ['empty', undefined]
  ]);
});

test('stream reset discards chunks, expectation and pending EOF; stale packets never revive audio', () => {
  const h = harness(8000);
  h.stream(constant(4000), 'old'); h.quantum(4000);
  h.stream(constant(1600), 'old');
  h.send({type:'reset', epoch:1});
  h.stream(new Float32Array(0), 'old', true, 0);
  h.stream(constant(4000), 'old', false, 0);
  assert.ok(h.render(40).every(x => x === 0));
  assert.equal(h.events('segmentEnd').length, 0);
  assert.equal(h.events('empty').length, 0);
  const s = h.stats();
  assert.equal(s.queueLength, 0); assert.equal(s.residentFrames, 0);
  assert.equal(s.expectationKnown, false); assert.equal(s.underrunCount, null);
  assert.equal(s.droppedSegments, 0);
  h.stream(constant(1, -.5), 'new', true, 1);
  assert.equal(h.quantum()[0][0], -.5);
  assert.equal(h.events('segmentEnd').at(-1).epoch, 1);
});

test('final-empty remains accepted if configure lowers the budget below already accepted PCM', () => {
  const h = harness(8000);
  h.stream(constant(1600), 'lowered');
  h.send({type:'configure', maxBufferedSeconds:.1});
  h.stream(new Float32Array(0), 'lowered', true);
  assert.equal(h.events('overflow').length, 0);
  assert.ok(h.quantum(1600)[0].every(x => x === .25));
  assert.equal(h.events('segmentEnd').length, 1);
});

test('appending to the tail segment works even when all 64 segment slots are occupied', () => {
  const h = harness(8000);
  for (let i = 0; i < 63; i++) h.stream(constant(1, .25), `done:${i}`, true);
  h.stream(constant(1, .5), 'tail');
  h.stream(constant(1, -.5), 'tail', true);
  assert.equal(h.stats().queueLength, 64);
  assert.equal(h.events('overflow').length, 0);
  const out = h.quantum()[0];
  assert.ok(out.slice(0, 63).every(x => x === .25));
  assert.equal(out[63], .5); assert.equal(out[64], -.5);
  assert.equal(h.events('segment').length, 64);
  assert.equal(h.events('segmentEnd').length, 64);
});

test('zero prebuffer still reports only one starvation episode while an open stream stays empty', () => {
  const h = harness(8000);
  h.send({type:'configure', prebufferMs:0});
  h.stream(constant(1), 'zero-buffer'); h.render(20);
  assert.equal(h.stats().underrunCount, 1);
  assert.equal(h.events('buffering').length, 1);
  h.stream(new Float32Array(0), 'zero-buffer', true);
  assert.equal(h.events('segmentEnd').length, 1);
});
