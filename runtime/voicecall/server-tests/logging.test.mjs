import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoiceServer, VERSION } from '../server.mjs'
import { createJsonlLogger, sanitizeClientEvent } from '../voice-log.mjs'

const chat = { messages: [{ role: 'user', content: 'PRIVATE_USER_TEXT' }] }
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const complete = () => new Response('data: {"choices":[{"delta":{"content":"PRIVATE_ANSWER"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream; private=SECRET' } })
async function fixture(t, options = {}) {
  const events = []
  const server = createVoiceServer({ config: { standaloneChat: true, siliconflowKey: 'test-fixture-only', ttsBase: 'https://tts.example.test', ttsVoice: 'fixture-voice', ttsModel: 'fixture-model' }, fetchImpl: complete, eventSink: event => events.push(event), timeoutMs: 1000, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, events, post: (path, body, headers = {}) => { const options = json(body); Object.assign(options.headers, headers); return fetch(base + path, options) } }
}
const diskEvent = count => ({ kind: 'heartbeat', count, source: 'client', serverAt: '2026-11-05T00:00:00.000Z' })

// All upstreams are injected. Temporary files only; no config or production logs are read.
test('diagnostics drops all sensitive/unknown fields and overwrites source/time', async t => {
  const { events, post } = await fixture(t)
  const payload = { kind: 'heartbeat', at: 12.5, pageId: 'p_1', turnId: 't-2', requestId: 'r_3', wallTime: '2026-11-05T00:00:00.000Z', phase: 'speaking', segment: 2, elapsedMs: 4, requestMs: 5, firstByteMs: 6, totalMs: 7, audioMs: 8, bytes: 9, chars: 10, tokens: 11, count: 12, seq: 13, status: 200, retryAfter: 2, active: true, reason: 'playing', ctxState: 'running', bufferedSeconds: 1.2, playedFrames: 4, framesSent: 5, jobs: 1, downloads: 0, playbackCount: 1, visibility: 'visible', errorName: 'AbortError', errorCode: 'ABORT_ERR', text: 'PRIVATE', message: 'PRIVATE', url: 'https://PRIVATE', stack: 'PRIVATE', raw: 'PRIVATE', transcript: 'PRIVATE', key: 'PRIVATE', body: { secret: 'PRIVATE' }, arbitrary: 'PRIVATE', source: 'forged', serverAt: 'forged' }
  const response = await post('/diagnostics', { events: [payload], key: 'PRIVATE' })
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { ok: true, accepted: 1 })
  assert.equal(events.length, 1); assert.equal(events[0].source, 'client'); assert.match(events[0].serverAt, /^\d{4}-/)
  const expected = { ...payload }; for (const key of ['text', 'message', 'url', 'stack', 'raw', 'transcript', 'key', 'body', 'arbitrary', 'source', 'serverAt']) delete expected[key]
  const { source, serverAt, ...received } = events[0]
  assert.deepEqual(received, expected); assert.doesNotMatch(JSON.stringify(events), /PRIVATE|forged/)
})

test('diagnostic optional fields are typed, finite, bounded and enum checked', () => {
  const safe = sanitizeClientEvent({ kind: 'test', at: NaN, time: Infinity, elapsedMs: -1, chars: '100', status: 600, active: 1, pageId: '../bad', turnId: 'a'.repeat(81), requestId: 'bad id', wallTime: 'not-time', phase: 'private prose', reason: 'not a token', errorName: 'x'.repeat(65), errorCode: 'bad/url', ctxState: 'unknown', visibility: 'unknown', segment: {}, bufferedSeconds: null })
  assert.deepEqual(safe, { kind: 'test' })
  assert.deepEqual(sanitizeClientEvent({ kind: 'test', time: 3, wallTime: 4 }), { kind: 'test', time: 3, wallTime: 4 })
  assert.equal(sanitizeClientEvent({ kind: 'has spaces' }), null)
  assert.equal(sanitizeClientEvent({ kind: 'x'.repeat(65) }), null)
})

test('diagnostics rejects bad shape/content/UTF8/batch and limits declared or chunked body to 32KiB', async t => {
  const { base, post, events } = await fixture(t)
  for (const body of [null, [], {}, { events: [] }, { events: {} }, { events: [null] }, { events: [[]] }, { events: [{}] }, { events: [{ kind: 'bad kind' }] }, { events: Array.from({ length: 41 }, () => ({ kind: 'test' })) }]) assert.equal((await post('/diagnostics', body)).status, 400)
  assert.equal((await fetch(base + '/diagnostics', { method: 'POST', body: '{}' })).status, 415)
  assert.equal((await fetch(base + '/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await fetch(base + '/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from([0xff]) })).status, 400)
  assert.equal((await post('/diagnostics', { events: [{ kind: 'test', text: 'x'.repeat(32768) }] })).status, 413)
  const chunkedStatus = await new Promise((resolve, reject) => {
    const req = http.request(base + '/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.write('{"events":[{"kind":"test","text":"'); req.write('x'.repeat(32768)); req.end('"}]}')
  })
  assert.equal(chunkedStatus, 413); assert.equal(events.length, 0)
  assert.equal((await post('/diagnostics', { events: Array.from({ length: 40 }, () => ({ kind: 'test' })) })).status, 202)
  assert.equal(events.length, 40)
  const exact = JSON.stringify({ events: [{ kind: 'test' }], padding: '' })
  const boundary = exact.replace('"padding":""', '"padding":"' + 'x'.repeat(32768 - Buffer.byteLength(exact)) + '"')
  assert.equal(Buffer.byteLength(boundary), 32768)
  assert.equal((await fetch(base + '/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: boundary })).status, 202)
})

test('diagnostics uses same Host/origin checks and exposes no GET logs/status', async t => {
  const { base, post, events } = await fixture(t)
  for (const headers of [{ origin: 'null' }, { origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await post('/diagnostics', { events: [{ kind: 'test' }] }, headers)).status, 403)
  const forged = await new Promise((resolve, reject) => {
    const req = http.request(base + '/diagnostics', { method: 'POST', headers: { host: 'foreign.example', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end('{"events":[{"kind":"test"}]}')
  })
  assert.equal(forged, 403); assert.equal(events.length, 0)
  for (const path of ['/diagnostics', '/diagnostics/status', '/logs/events.jsonl', '/logs/events.jsonl.1', '/voice-log.mjs']) assert.equal((await fetch(base + path)).status, 404)
  assert.equal((await post('/diagnostics', { events: [{ kind: 'test' }] }, { origin: base })).status, 202)
})

test('speech trace has unique echoed ID, validated client correlation, MIME-only headers and no content', async t => {
  const { post, base, events } = await fixture(t)
  const response = await post('/chat', chat, { 'x-voice-page-id': 'p_1', 'x-voice-turn-id': 't_2', 'x-voice-request-id': 'r_3' })
  assert.equal(await response.text(), 'PRIVATE_ANSWER')
  const id = response.headers.get('x-voice-request-id'); assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(events.map(e => e.kind), ['req-start', 'upstream-start', 'upstream-headers', 'upstream-first-byte', 'req-finish'])
  for (const event of events) { assert.equal(event.requestId, id); assert.equal(event.pageId, 'p_1'); assert.equal(event.turnId, 't_2'); assert.equal(event.clientRequestId, 'r_3'); assert.equal(event.phase, 'chat'); assert.equal(event.source, 'server'); assert(event.elapsedMs >= 0) }
  assert.equal(events[2].ct, 'text/event-stream'); assert.equal(events.at(-1).status, 200); assert(events.at(-1).bytes > 0); assert(events.at(-1).firstByteMs >= 0)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SECRET|siliconflow|https:|messages|content/)
  const next = await post('/chat', chat, { 'x-voice-page-id': 'bad id', 'x-voice-turn-id': 'x'.repeat(81), 'x-voice-request-id': 'bad/id' }); await next.text()
  assert.notEqual(next.headers.get('x-voice-request-id'), id)
  const nextStart = events.filter(e => e.kind === 'req-start')[1]
  assert(!('pageId' in nextStart)); assert(!('turnId' in nextStart)); assert(!('clientRequestId' in nextStart))
  const count = events.length
  await fetch(base + '/health'); await fetch(base + '/missing'); await post('/diagnostics', { events: [{ kind: 'test' }] })
  assert.equal(events.length, count + 1); assert.equal(VERSION, '2.0.3')
})

test('ASR, legacy TTS and PCM keep normal interfaces while tracing bytes', async t => {
  const { base, post, events } = await fixture(t, { fetchImpl: url => url.includes('transcriptions') ? new Response('{"text":" PRIVATE_ASR "}') : new Response(new Uint8Array(80), { headers: { 'content-type': 'application/octet-stream' } }) })
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8)
  assert.deepEqual(await (await fetch(base + '/asr', { method: 'POST', body: wav })).json(), { text: 'PRIVATE_ASR' })
  for (const path of ['/tts', '/ttsstream']) { const response = await post(path, { text: 'PRIVATE_TTS' }); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 80) }
  assert.deepEqual(events.filter(e => e.kind === 'req-finish').map(e => e.phase), ['asr', 'tts', 'ttsstream'])
  assert.equal(events.filter(e => e.kind === 'upstream-first-byte').length, 3)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|https:|body/)
})

test('upstream failures and HTTP retry log safe metadata, never exception messages or response bodies', async t => {
  let mode = 'network'
  const { post, events } = await fixture(t, { fetchImpl: () => { if (mode === 'network') throw Error('PRIVATE_URL_KEY_BODY'); return new Response('PRIVATE_BODY', { status: 429, headers: { 'retry-after': '9', 'content-type': 'text/plain; PRIVATE_KEY' } }) } })
  assert.equal((await post('/chat', chat)).status, 502)
  mode = 'http'; assert.equal((await post('/chat', chat)).status, 429)
  const failures = events.filter(e => e.kind === 'req-error')
  assert.equal(failures.length, 2); assert.equal(failures[0].reason, 'upstream_error'); assert.equal(failures[1].retryAfter, 9)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|https:|stack|message/)
})

test('timeout and disconnect produce one terminal abort with durations', async t => {
  const { post, events } = await fixture(t, { fetchImpl: () => new Promise(() => {}), timeoutMs: 40 })
  assert.equal((await post('/chat', chat)).status, 504)
  const timeout = events.find(e => e.kind === 'req-abort'); assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.status, 504); assert(timeout.totalMs >= 0)
  let started
  const ready = new Promise(resolve => { started = resolve })
  let aborted
  const abortSeen = new Promise(resolve => { aborted = resolve })
  const disconnectEvents = []
  const f = await fixture(t, { fetchImpl: () => { started(); return new Promise(() => {}) }, eventSink: event => { disconnectEvents.push(event); if (event.kind === 'req-abort') aborted() } })
  const req = http.request(f.base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' } }); req.on('error', () => {}); req.end(JSON.stringify(chat))
  await ready; req.destroy(); await abortSeen
  assert.equal(disconnectEvents.filter(e => e.kind === 'req-abort').length, 1)
  assert.equal(disconnectEvents.at(-1).reason, 'disconnected'); assert.equal(disconnectEvents.at(-1).status, 499)
  assert.equal(events.filter(e => ['req-abort', 'req-error', 'req-finish'].includes(e.kind)).length, 1)
})

test('stream progress is byte-only and throttled to at most once per second', async t => {
  let timer
  const { post, events } = await fixture(t, { timeoutMs: 2500, fetchImpl: () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new Uint8Array(64))
    timer = setTimeout(() => { c.enqueue(new Uint8Array(64)); c.enqueue(new Uint8Array(64)); c.close() }, 1050)
  } }), { headers: { 'content-type': 'application/octet-stream' } }) })
  t.after(() => clearTimeout(timer))
  const response = await post('/ttsstream', { text: 'PRIVATE' }); assert.equal((await response.arrayBuffer()).byteLength, 192)
  const progress = events.filter(e => e.kind === 'stream-progress')
  assert.equal(progress.length, 1); assert.equal(progress[0].bytes, 128); assert(progress[0].elapsedMs >= 1000)
  assert.equal(events.filter(e => e.kind === 'upstream-first-byte').length, 1)
  assert.equal(events.at(-1).bytes, 192)
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE|content|data/)
})

test('logger/sink failures never break diagnostics or normal speech', async t => {
  for (const eventSink of [() => { throw Error('PRIVATE_DISK_FAILURE') }, () => Promise.reject(Error('PRIVATE_DISK_FAILURE'))]) {
    const { post } = await fixture(t, { eventSink })
    assert.equal((await post('/diagnostics', { events: [{ kind: 'test' }] })).status, 202)
    assert.equal(await (await post('/chat', chat)).text(), 'PRIVATE_ANSWER')
  }
})

test('JSONL logger orders appends, sanitizes disk boundary and rotates only one bounded previous file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-log-test-'))
  const path = join(dir, 'nested', 'events.jsonl')
  const logger = createJsonlLogger({ path, maxBytes: 310 })
  for (let count = 0; count < 12; count++) assert.equal(logger.logEvent({ ...diskEvent(count), text: 'PRIVATE', key: 'PRIVATE', body: 'PRIVATE', unknown: 'PRIVATE' }), true)
  await logger.flush()
  assert.deepEqual((await readdir(join(dir, 'nested'))).sort(), ['events.jsonl', 'events.jsonl.1'])
  const current = await readFile(path, 'utf8'); const previous = await readFile(path + '.1', 'utf8')
  for (const file of [path, path + '.1']) assert((await stat(file)).size <= 310)
  const values = (previous + current).trim().split('\n').map(JSON.parse)
  assert.equal(values.at(-1).count, 11)
  for (let i = 1; i < values.length; i++) assert.equal(values[i].count, values[i - 1].count + 1)
  assert.doesNotMatch(previous + current, /PRIVATE|unknown|body|text|key/)
  assert.deepEqual(logger.stats(), { pending: 0, pendingBytes: 0, dropped: 0 })
})

test('injected logEvent persists HTTP metadata only and logger creation performs no I/O', async t => {
  let touched = false
  createJsonlLogger({ fs: { mkdir: async () => { touched = true } } })
  await Promise.resolve(); assert.equal(touched, false)
  const dir = await mkdtemp(join(tmpdir(), 'voice-http-log-test-'))
  const path = join(dir, 'events.jsonl')
  const logger = createJsonlLogger({ path })
  const { post } = await fixture(t, { eventSink: undefined, logEvent: logger.logEvent })
  assert.equal((await post('/diagnostics', { events: [{ kind: 'test', text: 'PRIVATE_TEXT', message: 'PRIVATE_MESSAGE', key: 'PRIVATE_KEY', url: 'https://PRIVATE_URL', stack: 'PRIVATE_STACK', raw: 'PRIVATE_RAW', transcript: 'PRIVATE_TRANSCRIPT', body: 'PRIVATE_BODY', unknown: 'PRIVATE_UNKNOWN' }] })).status, 202)
  assert.equal(await (await post('/chat', chat)).text(), 'PRIVATE_ANSWER')
  await logger.flush()
  const raw = await readFile(path, 'utf8')
  const records = raw.trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 6); assert.equal(records[0].source, 'client'); assert.equal(records.at(-1).kind, 'req-finish')
  assert.doesNotMatch(raw, /PRIVATE|https:|siliconflow|text\"|message\"|key\"|url\"|stack\"|raw\"|transcript\"|body\"|unknown\"/)
})

test('logger has bounded backlog and recovers from failed async append without rejected calls', async () => {
  let release
  let attempts = 0
  const appended = []
  const fs = { mkdir: async () => {}, stat: async () => ({ size: 0 }), rename: async () => {}, appendFile: async (_path, line) => { attempts++; if (attempts === 1) { await new Promise(resolve => { release = resolve }); throw Error('PRIVATE_DISK_FAILURE') } appended.push(JSON.parse(line)) } }
  const logger = createJsonlLogger({ fs, maxBacklog: 2, maxBacklogBytes: 1024 })
  assert(logger.logEvent(diskEvent(1))); assert(logger.logEvent(diskEvent(2))); assert.equal(logger.logEvent(diskEvent(3)), false)
  assert.equal(logger.stats().pending, 2)
  // Let mkdir/stat yield into the injected append, without timers or polling.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  release(); await logger.flush()
  assert.deepEqual(appended.map(e => e.count), [2]); assert.equal(logger.stats().dropped, 2)
  assert(logger.logEvent(diskEvent(4))); await logger.flush(); assert.deepEqual(appended.map(e => e.count), [2, 4])
  const tiny = createJsonlLogger({ fs, maxBacklogBytes: 1 }); assert.equal(tiny.logEvent(diskEvent(1)), false); assert.equal(tiny.stats().pending, 0)
})
