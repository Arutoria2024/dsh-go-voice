// Offline error-contract regressions. No config.json or cloud requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createVoiceServer } from '../server.mjs'

const pcmHeaders = { 'content-type': 'application/octet-stream' }
async function fixture(t, upstream) {
  const server = createVoiceServer({ config: { standaloneChat: true, siliconflowKey: 'test-fixture-only', ttsBase: 'https://tts.example.test', ttsVoice: 'fixture-voice', ttsModel: 'fixture-model' }, fetchImpl: upstream, timeoutMs: 1000 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, post: (path = '/ttsstream') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(path === '/chat' ? { messages: [{ role: 'user', content: '好' }] } : { text: '好' }) }) }
}
function splitResponse(bytes, headers = pcmHeaders) {
  let i = 0
  return new Response(new ReadableStream({ pull(c) { if (i < bytes.length) c.enqueue(bytes.subarray(i, ++i)); else c.close() } }), { headers })
}

test('upstream 429 retains status and bounded canonical Retry-After without private body/headers', async t => {
  let retryAfter = null; let cancelled = 0
  const { post } = await fixture(t, () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('private upstream key/body')) }, cancel() { cancelled++ } }), { status: 429, headers: { ...(retryAfter === null ? {} : { 'retry-after': retryAfter }), 'x-private': 'secret' } }))
  const future = new Date(Date.now() + 120_000).toUTCString()
  for (const [value, expected] of [[null, 5], ['0', 1], ['0042', 42], ['999999', 300], ['9'.repeat(400), 300], ['-1', 5], ['1.5', 5], ['tomorrow', 5], ['1,2', 5], ['Wed, 32 Nov 2026 00:00:00 GMT', 5], ['Thu, 01 Jan 1970 00:00:00 GMT', 1], [future, null]]) {
    retryAfter = value
    const response = await post()
    assert.equal(response.status, 429)
    const delay = Number(response.headers.get('retry-after'))
    if (expected === null) assert(delay >= 118 && delay <= 120); else assert.equal(delay, expected, String(value))
    assert.equal(response.headers.get('x-private'), null)
    assert.doesNotMatch(await response.text(), /private|key|secret/)
  }
  assert.equal(cancelled, 12)
  retryAfter = '7'
  assert.equal((await post('/chat')).status, 429)
  assert.equal((await post('/tts')).status, 429)
})

test('PCM type whitelist rejects missing, text, HTML, JSON, WAV and compressed media before body', async t => {
  let headers = {}
  const { post } = await fixture(t, () => new Response(new Uint8Array(100), { headers }))
  for (const type of [null, 'text/plain', 'text/html', 'application/json', 'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/L16', 'audio/pcm-unknown']) {
    headers = type === null ? {} : { 'content-type': type }
    const response = await post()
    assert.equal(response.status, 502, String(type))
    assert.match(response.headers.get('content-type'), /application\/json/)
  }
  for (headers of [{ ...pcmHeaders, 'content-encoding': 'gzip' }, { 'content-type': 'audio/pcm;rate=16000' }, { 'content-type': 'audio/pcm;channels=2' }, { 'content-type': 'audio/pcm;bits=32' }]) assert.equal((await post()).status, 502)
})

test('all explicit PCM types accept valid raw samples including printable PCM', async t => {
  let type = 'application/octet-stream'
  const raw = Buffer.from('abcdefghijklmnop')
  const { post } = await fixture(t, () => splitResponse(raw, { 'content-type': type }))
  for (type of ['application/octet-stream', 'audio/pcm', 'audio/x-pcm', 'audio/pcm; rate=24000; channels=1; bits=16']) {
    const response = await post(); assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw)
  }
})

test('even-sized containers, compressed headers and explicit errors are rejected before first PCM byte across one-byte chunks', async t => {
  let payload
  const { post } = await fixture(t, () => splitResponse(payload))
  const signatures = [
    Buffer.from('RIFF\x20\0\0\0WAVEfmt '), Buffer.from('RIFX\x20\0\0\0WAVE'), Buffer.from('RF64\xff\xff\xff\xffWAVE', 'latin1'),
    Buffer.from('ID3\x04\0\0\0\0\0\0'), Buffer.from('OggS\0\0'), Buffer.from('fLaC\0\0'),
    Buffer.from('FORM\0\0\0\0AIFF'), Buffer.from('caff\0\0'), Buffer.from('.snd\0\0'),
    Buffer.from([0x1f, 0x8b, 8, 0]),
    Buffer.from('\0\0\0\x18ftypM4A '), Buffer.from('PK\x03\x04'),
    Buffer.from('<!DOCTYPE html><html>private</html>'), Buffer.from(' \n<html>private</html>'),
    Buffer.from('{"error":"private key"}'), Buffer.from('error: private upstream failure'), Buffer.from('Too many requests'),
  ]
  for (const bytes of signatures) {
    payload = Buffer.concat([bytes, Buffer.alloc(100)])
    if (payload.length % 2) payload = Buffer.concat([payload, Buffer.alloc(1)])
    const response = await post(); assert.equal(response.status, 502, bytes.toString('hex'))
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.doesNotMatch(await response.text(), /private|key/)
  }
})

test('split odd network chunks retain every valid raw sample', async t => {
  const raw = Buffer.alloc(258)
  for (let i = 0; i < raw.length; i++) raw[i] = i % 19
  const { post } = await fixture(t, () => splitResponse(raw))
  const response = await post(); assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw)
})

test('odd total length before headers is 502; after headers stream terminates without dangling byte', async t => {
  let length = 3; let finish
  const { base, post } = await fixture(t, () => {
    if (length === 3) return new Response(new Uint8Array(3), { headers: pcmHeaders })
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65)); finish = () => c.close() } }), { headers: pcmHeaders })
  })
  assert.equal((await post()).status, 502)
  length = 65
  const response = await post(); assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const first = await reader.read(); assert.equal(first.value.length, 64)
  finish(); await assert.rejects(reader.read())
  assert.equal((await fetch(base + '/health')).status, 200)
})

// A sync word is not proof of MPEG: these are legal signed int16 sample pairs.
test('isolated MPEG and ADTS sync-like PCM samples are not rejected', async t => {
  let raw
  const { post } = await fixture(t, () => splitResponse(raw))
  for (const prefix of [[0xff,0xfb,0x10,0], [0xff,0xfb,0x90,0], [0xff,0xf1,0x50,0x80]]) {
    raw = Buffer.concat([Buffer.from(prefix), Buffer.alloc(128)])
    const r = await post(); assert.equal(r.status,200)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()),raw)
  }
})
