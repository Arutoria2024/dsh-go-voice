import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import { createVoiceServer, writeChunk } from '../server.mjs'

const encoder = new TextEncoder()
const event = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`
const complete = text => new Response(event(text) + 'data: [DONE]\n\n')
const chat = { messages: [{ role: 'user', content: '你好' }] }
const json = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
async function fixture(t, fetchImpl, options = {}) {
  const server = createVoiceServer({ config: { standaloneChat: true, siliconflowKey: 'test-fixture-only', chatModel: 'fixture-model', ttsBase: 'https://tts.example.test', ttsVoice: 'fixture-voice', ttsModel: 'fixture-model' }, fetchImpl, readAsset: name => {
    if (name === 'page.html') return '<html>fixture</html>'
    if (name.endsWith('.js')) return '// fixture'
    throw new Error('missing')
  }, timeoutMs: 1200, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, post: (path, value) => fetch(base + path, json(value)) }
}

// All upstreams below are injected; this file never reads config.json or contacts a cloud.
test('public config, explicit static whitelist, no config or source disclosure', async t => {
  const { base } = await fixture(t, () => { throw Error('unexpected upstream') })
  const health = await (await fetch(base + '/health')).json()
  assert.equal(health.chatModel, 'fixture-model'); assert.equal(health.voiceId, 'fixture-voice')
  assert.deepEqual(health.tts, { provider: 'local', model: 'fixture-model', format: 'pcm_s16le', sampleRate: 24000, channels: 1, bitsPerSample: 16, key: false })
  assert(!JSON.stringify(health).includes('test-fixture-only'))
  for (const path of ['/', '/index.html', '/client.js', '/pcm-worklet.js', '/manifest.json']) assert.equal((await fetch(base + path)).status, 200)
  for (const path of ['/config.json', '/server.mjs', '/server-tests/server.test.mjs', '/%2e%2e/config.json', '/page-debug.html']) assert.equal((await fetch(base + path)).status, 404)
})

test('POST blocks foreign/null origin, cross-site and forged Host; allows same-origin and originless local clients', async t => {
  let calls = 0
  const { base } = await fixture(t, () => { calls++; return complete('好') })
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example:3457' }, { origin: 'http://localhost:3457' }]) {
    const options = json(chat); Object.assign(options.headers, headers)
    const status = await new Promise((resolve, reject) => {
      const request = http.request(base + '/chat', { method: 'POST', headers: options.headers }, response => { response.resume(); resolve(response.statusCode) })
      request.on('error', reject); request.end(options.body)
    })
    assert.equal(status, 403, JSON.stringify(headers))
  }
  assert.equal(calls, 0)
  const options = json(chat); options.headers.origin = base
  assert.equal(await (await fetch(base + '/chat', options)).text(), '好')
  assert.equal(await (await fetch(base + '/chat', json(chat))).text(), '好')
})

test('body shape, UTF8, content type, empty and size checks fail before upstream', async t => {
  let calls = 0
  const { base, post } = await fixture(t, () => { calls++; return complete('unexpected') })
  for (const body of [null, [], {}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'user', content: 9 }] }, { messages: [{ role: 'user', content: '' }] }, { messages: [{ role: 'user', content: 'x'.repeat(16001) }] }]) assert.equal((await post('/chat', body)).status, 400)
  for (const body of [{}, { text: '' }, { text: 7 }, { text: 'x'.repeat(601) }]) assert.equal((await post('/ttsstream', body)).status, 400)
  assert.equal((await fetch(base + '/chat', { method: 'POST', body: '{}' })).status, 415)
  assert.equal((await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from([0xff]) })).status, 400)
  assert.equal((await post('/chat', { messages: [], padding: 'x'.repeat(130 * 1024) })).status, 413)
  assert.equal(calls, 0)
})

test('chat preserves endpoint and cloud parameters, Chinese split byte-by-byte and final unterminated DONE', async t => {
  let request
  const bytes = encoder.encode(event('你好，鲸鱼。') + 'data: [DONE]')
  const { post } = await fixture(t, (url, options) => {
    request = { url, options }
    let i = 0
    return new Response(new ReadableStream({ pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close() } }))
  })
  const response = await post('/chat', chat)
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/plain.*utf-8/)
  assert.equal(await response.text(), '你好，鲸鱼。')
  assert.equal(request.url, 'https://api.siliconflow.cn/v1/chat/completions')
  const body = JSON.parse(request.options.body)
  assert.equal(body.model, 'fixture-model'); assert.equal(body.enable_thinking, false); assert.equal(body.stream, true)
  assert.equal(body.messages[0].role, 'system'); assert.deepEqual(body.messages.slice(1), chat.messages)
})

test('chat retains last 12 validated messages', async t => {
  let received
  const { post } = await fixture(t, (_url, options) => { received = JSON.parse(options.body); return complete('好') })
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: String(i), discarded: 'extra' }))
  await (await post('/chat', { messages })).text()
  assert.equal(received.messages.length, 13); assert.deepEqual(received.messages[1], { role: 'user', content: '8' })
})

test('PCM endpoint bytes and MP3 legacy endpoint preserve voice/breeze request', async t => {
  const requests = []
  const audio = Uint8Array.from([0, 1, 255, 127, 0, 128])
  const { post } = await fixture(t, (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response(audio, { headers: { 'content-type': 'application/octet-stream' } }) })
  const pcm = await post('/ttsstream', { text: '你好' })
  assert.equal(pcm.status, 200); assert.equal(pcm.headers.get('x-audio-sample-rate'), '24000')
  assert.deepEqual(new Uint8Array(await pcm.arrayBuffer()), audio)
  const mp3 = await post('/tts', { text: '你好' })
  assert.equal(mp3.headers.get('content-type'), 'audio/mpeg'); assert.equal((await mp3.arrayBuffer()).byteLength, 6)
  assert.equal(requests[0].url, 'https://tts.example.test/v1/text-to-speech/fixture-voice/stream?output_format=pcm&sample_rate=24000')
  assert.match(requests[1].url, /output_format=mp3&sample_rate=24000$/)
  for (const request of requests) assert.deepEqual(request.body, { text: '你好', model_id: 'fixture-model' })
})

test('ASR WAV validation, unchanged upstream, trimmed JSON response', async t => {
  let calls = 0
  const { base } = await fixture(t, (url, options) => {
    calls++; assert.equal(url, 'https://api.siliconflow.cn/v1/audio/transcriptions')
    assert.equal(options.body.get('model'), 'Qwen/Qwen3-ASR-1.7B')
    return new Response(JSON.stringify({ text: '  你好  ' }))
  })
  assert.equal((await fetch(base + '/asr', { method: 'POST', body: 'not audio' })).status, 400)
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8)
  const response = await fetch(base + '/asr', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav })
  assert.deepEqual(await response.json(), { text: '你好' }); assert.equal(calls, 1)
})

test('upstream HTTP/network/errors/empty PCM become non-2xx without leaking upstream text', async t => {
  let mode = 'http'
  const { post } = await fixture(t, () => {
    if (mode === 'http') return new Response('private upstream details', { status: 401 })
    if (mode === 'network') throw new Error('sensitive URL/key')
    if (mode === 'malformed') return new Response('data: invalid-json\n')
    if (mode === 'chat-error') return new Response('data: {"error":"secret"}\n')
    return new Response(new Uint8Array())
  })
  for (mode of ['http', 'network', 'malformed', 'chat-error']) {
    const response = await post('/chat', chat)
    assert.equal(response.status, 502)
    assert.doesNotMatch(await response.text(), /private|sensitive|secret/)
  }
  mode = 'empty'; assert.equal((await post('/ttsstream', { text: '好' })).status, 502)
})

test('total timeout aborts pending upstream fetch', async t => {
  let signal
  const { post } = await fixture(t, (_url, options) => { signal = options.signal; return new Promise(() => {}) }, { timeoutMs: 60 })
  const response = await post('/chat', chat)
  assert.equal(response.status, 504); assert.equal(signal.aborted, true)
})

test('timeout while reading upstream cancels reader and gives non-2xx before tokens', async t => {
  let cancelled = false; let signal
  const { post } = await fixture(t, (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'application/octet-stream' } })
  }, { timeoutMs: 60 })
  assert.equal((await post('/ttsstream', { text: '好' })).status, 504)
  assert.equal(signal.aborted, true); assert.equal(cancelled, true)
})

test('concurrent chat requests remain isolated', async t => {
  const { post } = await fixture(t, (_url, options) => complete(JSON.parse(options.body).messages.at(-1).content))
  const answers = await Promise.all(Array.from({ length: 16 }, async (_, i) => (await post('/chat', { messages: [{ role: 'user', content: `编号${i}` }] })).text()))
  assert.deepEqual(answers, Array.from({ length: 16 }, (_, i) => `编号${i}`))
})

test('client disconnect cancels upstream and reader, independent next request survives', async t => {
  let signal; let cancelled = false; let started
  const ready = new Promise(resolve => { started = resolve })
  const { base, post } = await fixture(t, (_url, options) => {
    if (JSON.parse(options.body).messages.at(-1).content === 'next') return complete('还活着')
    signal = options.signal
    return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(event('第一句'))); started() }, cancel() { cancelled = true } }))
  })
  const aborted = new Promise(resolve => {
    const request = http.request(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve() })
    })
    request.on('error', () => {}); request.end(JSON.stringify(chat))
  })
  await ready; await aborted
  if (!signal.aborted) await once(signal, 'abort')
  assert.equal(signal.aborted, true); assert.equal(cancelled, true)
  assert.equal(await (await post('/chat', { messages: [{ role: 'user', content: 'next' }] })).text(), '还活着')
})

test('disconnect before upstream response aborts pending fetch', async t => {
  let signal; let upstreamStarted
  const ready = new Promise(resolve => { upstreamStarted = resolve })
  const { base, post } = await fixture(t, (_url, options) => {
    if (JSON.parse(options.body).messages.at(-1).content === 'next') return complete('独立')
    signal = options.signal; upstreamStarted(); return new Promise(() => {})
  })
  const request = http.request(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' } })
  request.on('error', () => {}); request.end(JSON.stringify(chat))
  await ready; request.destroy()
  if (!signal.aborted) await once(signal, 'abort')
  assert.equal(signal.aborted, true)
  assert.equal(await (await post('/chat', { messages: [{ role: 'user', content: 'next' }] })).text(), '独立')
})

test('timeout after stream starts truncates stream and cancels stalled upstream', async t => {
  let cancelled = false
  const { base, post } = await fixture(t, () => new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(event('开始'))) },
    cancel() { cancelled = true },
  })), { timeoutMs: 100 })
  const response = await post('/chat', chat)
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  assert.equal(cancelled, true)
  assert.equal((await fetch(base + '/health')).status, 200)
})

test('oversized chunked body gets 413 without contacting upstream', async t => {
  let calls = 0
  const { base } = await fixture(t, () => { calls++; return complete('unexpected') })
  const status = await new Promise((resolve, reject) => {
    const request = http.request(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
    request.write('{"padding":"'); request.write('a'.repeat(129 * 1024)); request.end('"}')
  })
  assert.equal(status, 413); assert.equal(calls, 0)
})

test('half-open request body times out without fetching upstream', async t => {
  let calls = 0
  const { server } = await fixture(t, () => { calls++; return complete('unexpected') }, { timeoutMs: 70 })
  const socket = net.connect(server.address().port, '127.0.0.1')
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  let response = ''
  socket.on('data', chunk => { response += chunk })
  socket.write(`POST /chat HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`)
  await once(socket, 'end')
  assert.match(response, /HTTP\/1.1 504/); assert.equal(calls, 0)
})

for (const endpoint of ['/chat', '/ttsstream']) {
  test(`midstream error closes ${endpoint} without second headers; health remains up`, async t => {
    let breakStream
    const { base, post } = await fixture(t, () => new Response(new ReadableStream({ start(c) {
      c.enqueue(endpoint === '/chat' ? encoder.encode(event('已开始')) : new Uint8Array(64))
      breakStream = () => c.error(new Error('fixture stream broke'))
    } }), { headers: { 'content-type': endpoint === '/chat' ? 'text/event-stream' : 'application/octet-stream' } }))
    const response = await post(endpoint, endpoint === '/chat' ? chat : { text: '好' })
    assert.equal(response.status, 200)
    breakStream()
    await assert.rejects(response.arrayBuffer())
    assert.equal((await fetch(base + '/health')).status, 200)
  })
}

test('incomplete chat without DONE is non-2xx before content', async t => {
  const { post } = await fixture(t, () => new Response(': heartbeat\n'))
  assert.equal((await post('/chat', chat)).status, 502)
})

test('backpressure waits drain and removes listeners', async () => {
  const res = new EventEmitter(); res.write = () => false
  const signal = new AbortController().signal
  const pending = writeChunk(res, 'test', signal)
  assert.equal(res.listenerCount('close'), 1)
  res.emit('drain'); await pending
  for (const name of ['drain', 'close', 'error']) assert.equal(res.listenerCount(name), 0)
})

test('close/abort while waiting drain rejects promptly and cleans listeners', async () => {
  for (const cause of ['close', 'abort', 'error']) {
    const res = new EventEmitter(); res.write = () => false
    const ac = new AbortController(); const pending = writeChunk(res, 'test', ac.signal)
    if (cause === 'abort') ac.abort(new Error('fixture abort')); else res.emit(cause)
    await assert.rejects(pending)
    for (const name of ['drain', 'close', 'error']) assert.equal(res.listenerCount(name), 0)
  }
})
