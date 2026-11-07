const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const ROOT = join(__dirname, '..');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
test.after(async () => { await browser?.close(); });
async function fixture(t, mode = {}) {
  const page = await browser.newPage(); t.after(() => page.close());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/' || path === '/client.js') return route.fulfill({ contentType: path === '/' ? 'text/html' : 'text/javascript', body: readFileSync(join(ROOT, path === '/' ? 'page.html' : 'client.js'), 'utf8') });
    return route.abort();
  });
  await page.addInitScript(mode => {
    const m = window.mock = { contexts: [], streams: [], pending: {}, health: 0, gum: 0, sources: [] };
    const defer = name => new Promise((resolve, reject) => { m.pending[name] = { resolve, reject }; });
    const resource = () => ({ connect() {}, disconnect() {}, gain: { value: 0 }, frequency: { value: 0 }, Q: { value: 0 } });
    class AudioContext {
      constructor() { this.id = m.contexts.length; this.closed = false; this.sampleRate = 48000; this.state = 'suspended'; m.contexts.push(this); this.audioWorklet = { addModule: () => mode.module ? defer('module' + this.id) : Promise.resolve() }; }
      async resume() { if (mode.resume) await defer('resume' + this.id); this.state = 'running'; }
      async close() { this.closed = true; this.state = 'closed'; }
      createBiquadFilter() { return resource(); }
      createDynamicsCompressor() { const n = resource(); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = { value: 0 }; return n; }
      createGain() { return resource(); }
      createScriptProcessor() { return resource(); }
      createMediaStreamSource(stream) { m.sources.push({ context: this.id, stream: stream.id }); if (mode.sourceError) throw Error('fixture source error'); return resource(); }
    }
    window.AudioContext = AudioContext;
    window.AudioWorkletNode = class { constructor() { this.port = { postMessage() {} }; } connect() {} disconnect() {} };
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia() { const id = m.gum++; return defer('gum' + id); } } });
    m.stream = () => { const track = { enabled: true, stopped: false, stop() { this.stopped = true; this.enabled = false; } }; const stream = { id: m.streams.length, track, getTracks: () => [track] }; m.streams.push(stream); return stream; };
    window.fetch = async (path, options) => { if (path !== '/health') throw Error('unexpected cloud request: ' + path); const id = m.health++; m.lastHealthSignal = options.signal; if (mode.health) await defer('health' + id); return { ok: true, json: async () => { if (mode.json) await defer('json' + id); return { ok: true }; } }; };
    m.hidden = value => { Object.defineProperty(document, 'hidden', { configurable: true, value }); document.dispatchEvent(new Event('visibilitychange')); };
  }, mode);
  await page.goto('http://voice.test/');
  return { page, errors };
}
const pending = (page, key) => page.waitForFunction(key => !!window.mock.pending[key], key);
const resolve = (page, key, stream = false) => page.evaluate(({ key, stream }) => { mock.pending[key].resolve(stream ? mock.stream() : undefined); }, { key, stream });
const ended = page => page.waitForFunction(() => document.body.dataset.state === 'ended');
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

test('hangup during pending microphone permission stops late stream', async t => {
  const { page, errors } = await fixture(t);
  await page.click('#talk'); await pending(page, 'gum0');
  assert.equal(await page.isEnabled('#hangup'), true); await page.click('#hangup'); await ended(page);
  await resolve(page, 'gum0', true); await settle(page);
  assert.deepEqual(await page.evaluate(() => ({ stopped: mock.streams[0].track.stopped, state: document.body.dataset.state, sources: mock.sources.length })), { stopped: true, state: 'ended', sources: 0 }); assert.deepEqual(errors, []);
});

test('old permission result cannot replace a newer connected call', async t => {
  const { page, errors } = await fixture(t);
  await page.click('#talk'); await pending(page, 'gum0'); await page.click('#hangup');
  await page.click('#talk'); await pending(page, 'gum1'); await resolve(page, 'gum1', true);
  await page.waitForFunction(() => document.body.dataset.state === 'listening');
  await resolve(page, 'gum0', true); await settle(page);
  assert.deepEqual(await page.evaluate(() => ({ tracks: mock.streams.map(s => s.track.stopped), sources: mock.sources, state: document.body.dataset.state })), { tracks: [false, true], sources: [{ context: 1, stream: 0 }], state: 'listening' }); assert.deepEqual(errors, []);
});

for (const stage of ['resume', 'health', 'json', 'module']) {
  test(`background during delayed ${stage} ends call and ignores late completion`, async t => {
    const { page, errors } = await fixture(t, { [stage]: true });
    await page.click('#talk'); await pending(page, stage + '0');
    await page.evaluate(() => mock.hidden(true)); await ended(page);
    if (stage === 'health' || stage === 'json') assert.equal(await page.evaluate(() => mock.lastHealthSignal.aborted), true);
    await resolve(page, stage + '0'); await settle(page);
    assert.equal(await page.evaluate(() => mock.gum), 0); assert.equal(await page.getAttribute('body', 'data-state'), 'ended');
    await page.evaluate(() => mock.hidden(false)); await settle(page); assert.equal(await page.evaluate(() => mock.contexts.length), 1); assert.deepEqual(errors, []);
  });
}

test('background pending GUM stops late stream; foreground requires manual start', async t => {
  const { page, errors } = await fixture(t);
  await page.click('#talk'); await pending(page, 'gum0'); await page.evaluate(() => mock.hidden(true));
  await resolve(page, 'gum0', true); await settle(page); assert.equal(await page.evaluate(() => mock.streams[0].track.stopped), true);
  await page.evaluate(() => mock.hidden(false)); await settle(page); assert.equal(await page.evaluate(() => mock.gum), 1); assert.equal(await page.getAttribute('body', 'data-state'), 'ended'); assert.deepEqual(errors, []);
});

test('pagehide cancels pending permission and active call tracks', async t => {
  const { page } = await fixture(t);
  await page.click('#talk'); await pending(page, 'gum0'); await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await resolve(page, 'gum0', true); await settle(page); assert.equal(await page.evaluate(() => mock.streams[0].track.stopped), true);
  await page.click('#talk'); await pending(page, 'gum1'); await resolve(page, 'gum1', true);
  await page.waitForFunction(() => document.body.dataset.state === 'listening'); await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => mock.streams[1].track.stopped), true); await ended(page);
});

test('old delayed resume completion does not close or build into the newer context', async t => {
  const { page, errors } = await fixture(t, { resume: true });
  await page.click('#talk'); await pending(page, 'resume0'); await page.click('#hangup');
  await page.click('#talk'); await pending(page, 'resume1'); await resolve(page, 'resume1');
  await pending(page, 'gum0'); await resolve(page, 'gum0', true);
  await page.waitForFunction(() => document.body.dataset.state === 'listening');
  await resolve(page, 'resume0'); await settle(page);
  assert.deepEqual(await page.evaluate(() => ({ closed: mock.contexts.map(c => c.closed), health: mock.health, sources: mock.sources, state: document.body.dataset.state })), { closed: [true, false], health: 1, sources: [{ context: 1, stream: 0 }], state: 'listening' }); assert.deepEqual(errors, []);
});

test('permission rejection releases audio and allows manual text-only retry', async t => {
  const { page, errors } = await fixture(t);
  await page.click('#talk'); await pending(page, 'gum0');
  await page.evaluate(() => mock.pending.gum0.reject(new DOMException('fixture denied', 'NotAllowedError')));
  await page.waitForFunction(() => document.body.dataset.state === 'error');
  assert.equal(await page.evaluate(() => mock.contexts[0].closed), true);
  await page.click('#errorRetry'); await page.waitForFunction(() => document.body.dataset.state === 'muted');
  assert.deepEqual(await page.evaluate(() => ({ gum: mock.gum, connected: document.body.dataset.connected })), { gum: 1, connected: 'true' }); assert.deepEqual(errors, []);
});

test('rapid start clicks deduplicate microphone requests and failure releases context', async t => {
  const { page, errors } = await fixture(t, { sourceError: true });
  await page.evaluate(() => { for (let i = 0; i < 5; i++) document.querySelector('#talk').dispatchEvent(new Event('click')); });
  await pending(page, 'gum0'); assert.equal(await page.evaluate(() => mock.gum), 1);
  await resolve(page, 'gum0', true); await page.waitForFunction(() => document.body.dataset.state === 'error');
  assert.deepEqual(await page.evaluate(() => ({ stopped: mock.streams[0].track.stopped, closed: mock.contexts[0].closed, connected: document.body.dataset.connected })), { stopped: true, closed: true, connected: 'false' }); assert.deepEqual(errors, []);
});
