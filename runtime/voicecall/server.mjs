// Loopback-only voice service. Import createVoiceServer for offline, injected-upstream tests.
import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createJsonlLogger, sanitizeClientEvent, validVoiceId, DIAGNOSTICS_LIMIT, DIAGNOSTICS_BATCH } from './voice-log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const VERSION = '2.0.3'
const SYSTEM = `你是用户的语音助手。说话简短、自然、口语化，每次一两句；不要列表、不要括号写心理活动。`
const ASSETS = new Map([
  ['/', ['page.html', 'text/html; charset=utf-8']],
  ['/index.html', ['page.html', 'text/html; charset=utf-8']],
  ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/pcm-worklet.js', ['pcm-worklet.js', 'text/javascript; charset=utf-8']],
  ['/icon.png', ['icon.png', 'image/png']],
])
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const disconnected = () => new HttpError(499, 'client disconnected')

// Relay only a bounded, canonical delay; never relay arbitrary upstream headers/body.
function retryAfterSeconds(value) {
  if (value === null) return '5'
  const raw = value.trim()
  let seconds
  if (/^\d+$/.test(raw)) seconds = Math.min(300, Number(raw))
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) && new Date(raw).toUTCString() === raw) seconds = Math.ceil((Date.parse(raw) - Date.now()) / 1000)
  return String(Number.isFinite(seconds) ? Math.min(300, Math.max(1, seconds)) : 5)
}

function checkPcmType(response) {
  const type = (response.headers.get('content-type') || '').toLowerCase().trim()
  if (!/^(application\/octet-stream|audio\/(x-)?pcm)(\s*;|$)/.test(type)) throw new HttpError(502, 'unexpected PCM content type')
  // Explicit contradictory metadata must not be relabelled as our fixed PCM contract.
  for (const [key, expected] of [['rate', '24000'], ['channels', '1'], ['bits', '16']]) {
    const parameter = type.match(new RegExp(`;\\s*${key}\\s*=\\s*"?([^;"\\s]+)`))
    if (parameter && parameter[1] !== expected) throw new HttpError(502, 'unexpected PCM parameters')
  }
  if (response.headers.has('content-encoding') && response.headers.get('content-encoding').toLowerCase() !== 'identity') throw new HttpError(502, 'unexpected PCM encoding')
}

function checkPcmPrefix(prefix) {
  const signature = prefix.toString('latin1')
  const container = (/^(RIFF|RIFX|RF64|BW64)/.test(signature) && signature.slice(8, 12) === 'WAVE') || /^(ID3|OggS|fLaC|FORM|caff|\.snd|PK\x03\x04|\x1f\x8b)/.test(signature) || signature.slice(4, 8) === 'ftyp'
  // A lone MPEG/ADTS sync word is also a perfectly valid pair of PCM samples.
  // Only reject framed compressed audio if a second consistent frame is present.
  let mp3 = false; let adts = false
  if (prefix.length >= 4 && prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0) {
    const version = (prefix[1] >> 3) & 3, layer = (prefix[1] >> 1) & 3
    const bitrate = (prefix[2] >> 4) & 15, rateIndex = (prefix[2] >> 2) & 3
    if (version !== 1 && layer === 1 && bitrate > 0 && bitrate < 15 && rateIndex < 3) {
      const rates = [44100, 48000, 32000], table = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]
      const rate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
      const next = Math.floor((version === 3 ? 144 : 72) * table[bitrate] * 1000 / rate) + ((prefix[2] >> 1) & 1)
      mp3 = next + 4 <= prefix.length && prefix[next] === 0xff && (prefix[next + 1] & 0xfe) === (prefix[1] & 0xfe)
    }
    if (prefix.length >= 7 && (prefix[1] & 0xf6) === 0xf0) {
      const next = ((prefix[3] & 3) << 11) | (prefix[4] << 3) | (prefix[5] >> 5)
      adts = next >= 7 && next + 7 <= prefix.length && prefix[next] === 0xff && (prefix[next + 1] & 0xf6) === 0xf0
    }
  }
  // Text disguised as octet-stream: match explicit error/markup syntax, not printable PCM.
  const text = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  const errorText = /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<\?xml\b|\{\s*"(?:error|message|detail)"\s*:|error\s*[:{]|unauthorized\b|forbidden\b|too many requests\b|bad gateway\b|internal server error\b)/i.test(text)
  if (container || mp3 || adts || errorText) throw new HttpError(502, 'unexpected non-PCM audio response')
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  // A streaming error must terminate the stream, never emit a second status or PCM error text.
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(JSON.stringify(value))
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

function readBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = error => { cleanup(); req.resume(); reject(error) }
    const onError = () => fail(disconnected())
    const onAborted = () => fail(disconnected())
    const onAbort = () => fail(signal.reason)
    const onData = chunk => {
      size += chunk.length
      if (size > limit) { fail(new HttpError(413, 'body too large')); return }
      chunks.push(chunk)
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    if (signal.aborted) { fail(signal.reason); return }
    const length = req.headers['content-length']
    if (length && Number(length) > limit) { fail(new HttpError(413, 'body too large')); return }
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readJson(req, signal, limit = 128 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'expected application/json')
  let body
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req, limit, signal))) }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid JSON body') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected JSON object')
  return body
}

// Install all drain/close/abort listeners before write, including the close-without-drain case.
export function writeChunk(res, chunk, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain); res.off('close', onClose); res.off('error', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(disconnected()) }
    const onAbort = () => { cleanup(); reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    if (res.destroyed || res.writableEnded) { reject(disconnected()); return }
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try { if (res.write(chunk)) onDrain() } catch (error) { cleanup(); reject(error) }
  })
}

async function* upstreamChunks(response, signal, observe) {
  if (!response.body) throw new HttpError(502, 'empty upstream response')
  const reader = response.body.getReader()
  const cancel = () => { reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal)
      if (signal.aborted) throw signal.reason
      if (done) return
      observe?.(value.byteLength)
      yield value
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

async function bufferedResponse(response, signal, limit, observe) {
  const chunks = []; let size = 0
  for await (const chunk of upstreamChunks(response, signal, observe)) {
    size += chunk.length
    if (size > limit) throw new HttpError(502, 'upstream response too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function checkLocalRequest(req, server) {
  const host = req.headers.host
  if (typeof host !== 'string') throw new HttpError(403, 'invalid host')
  const port = server.address()?.port
  if (!['127.0.0.1', 'localhost', '[::1]'].some(name => host.toLowerCase() === `${name}:${port}`)) throw new HttpError(403, 'invalid host')
  if (req.method !== 'POST') return
  const origin = req.headers.origin
  if ((origin !== undefined && origin !== `http://${host.toLowerCase()}`) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'cross-site request blocked')
  }
}

export function createVoiceServer({ config = {}, fetchImpl = globalThis.fetch, readAsset = name => readFileSync(join(HERE, name)), timeoutMs = 90_000, logEvent, eventSink = logEvent } = {}) {
  // Logging is fire-and-forget and may be injected without touching production files.
  const emit = event => {
    try { Promise.resolve(eventSink?.(event)).catch(() => {}) } catch {}
  }
  function deriveConfig(source) {
    const cfg = source && typeof source === 'object' ? source : {}
    const ttsBase = (cfg.ttsBase || '').trim()
    const ttsKey = cfg.ttsKey || ''
    const ttsProvider = cfg.ttsProvider || 'local'
    const ttsModel = cfg.ttsModel || 'default'
    const ttsSampleRate = Number(cfg.ttsSampleRate) || 24000
    const voiceId = cfg.ttsVoice || 'default'
    const chatModel = cfg.chatModel || ''
    const asrModel = cfg.asrModel || 'Qwen/Qwen3-ASR-1.7B'
    return {
      raw: cfg, ttsBase, ttsKey, ttsProvider, ttsModel, ttsSampleRate, voiceId, chatModel, asrModel,
      publicConfig: {
        ok: true, version: VERSION, chatModel, voiceId,
        configRevision: cfg.__revision || 'default',
        tts: { provider: ttsProvider, model: ttsModel, format: 'pcm_s16le', sampleRate: ttsSampleRate, channels: 1, bitsPerSample: 16, key: !!ttsKey },
      },
    }
  }
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController()
    const { signal } = controller
    const cfg = deriveConfig(typeof config === 'function' ? config() : config)
    const requestId = randomUUID()
    const startedAt = performance.now()
    const elapsed = () => Math.round((performance.now() - startedAt) * 100) / 100
    const correlation = { requestId }
    for (const [header, field] of [['x-voice-page-id', 'pageId'], ['x-voice-turn-id', 'turnId'], ['x-voice-request-id', 'clientRequestId']]) {
      if (validVoiceId(req.headers[header])) correlation[field] = req.headers[header]
    }
    let phase; let terminal = false; let bytes = 0; let upstreamAt; let firstByteMs; let lastProgressAt = 0
    const trace = (kind, fields = {}) => emit({ kind, ...correlation, phase, elapsedMs: elapsed(), ...fields, source: 'server', serverAt: new Date().toISOString() })
    const finishTrace = (kind, fields = {}) => {
      if (!phase || terminal) return
      terminal = true
      trace(kind, { bytes, totalMs: elapsed(), ...(firstByteMs === undefined ? {} : { firstByteMs }), ...fields })
    }
    const onTraceAbort = () => finishTrace('req-abort', { status: signal.reason?.status === 504 ? 504 : 499, reason: signal.reason?.status === 504 ? 'timeout' : 'disconnected' })
    const observeChunk = length => {
      if (!length) return
      bytes += length
      if (firstByteMs === undefined) {
        firstByteMs = Math.round((performance.now() - upstreamAt) * 100) / 100
        trace('upstream-first-byte', { bytes, firstByteMs })
      }
      const now = performance.now()
      if (now - lastProgressAt >= 1000) { lastProgressAt = now; trace('stream-progress', { bytes }) }
    }
    const timer = setTimeout(() => controller.abort(new HttpError(504, 'request timeout')), timeoutMs)
    timer.unref()
    const onDisconnect = () => { if (!res.writableFinished) controller.abort(disconnected()) }
    const onError = () => controller.abort(disconnected())
    req.once('aborted', onError); req.once('error', onError)
    res.once('close', onDisconnect); res.once('error', onError)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('cross-origin-resource-policy', 'same-origin')
    res.setHeader('x-voice-request-id', requestId)
    signal.addEventListener('abort', onTraceAbort, { once: true })
    res.once('finish', () => finishTrace('req-finish', { status: res.statusCode }))
    const fetchUpstream = async (url, options) => {
      upstreamAt = performance.now(); lastProgressAt = upstreamAt
      trace('upstream-start', { requestMs: elapsed() })
      const response = await abortable(fetchImpl(url, { ...options, signal }), signal)
      const rawType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
      const ct = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawType) && rawType.length <= 100 ? rawType : undefined
      trace('upstream-headers', { status: response.status, requestMs: Math.round((performance.now() - upstreamAt) * 100) / 100, ...(ct ? { ct } : {}) })
      if (!response.ok) {
        response.body?.cancel().catch(() => {})
        const error = new HttpError(response.status === 429 ? 429 : 502, `upstream HTTP ${response.status}`)
        if (response.status === 429) error.retryAfter = retryAfterSeconds(response.headers.get('retry-after'))
        throw error
      }
      return response
    }
    try {
      checkLocalRequest(req, server)
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/diagnostics') {
        const body = await readJson(req, signal, DIAGNOSTICS_LIMIT)
        if (!Array.isArray(body.events) || !body.events.length || body.events.length > DIAGNOSTICS_BATCH) throw new HttpError(400, 'expected 1 to 40 events')
        const events = body.events.map(sanitizeClientEvent)
        if (events.some(event => !event)) throw new HttpError(400, 'invalid diagnostic event')
        const serverAt = new Date().toISOString()
        for (const event of events) emit({ ...event, serverAt, source: 'client' })
        return sendJson(res, 202, { ok: true, accepted: events.length })
      }
      if (req.method === 'GET' && ASSETS.has(url.pathname)) {
        const [name, type] = ASSETS.get(url.pathname)
        let asset
        try { asset = readAsset(name) } catch { throw new HttpError(404, 'not found') }
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(asset); return
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, cfg.publicConfig)
      if (req.method === 'GET' && url.pathname === '/manifest.json') return sendJson(res, 200, {
        name: '语音通话', short_name: '语音通话', start_url: '/', scope: '/',
        display: 'standalone', background_color: '#0d1117', theme_color: '#0d1117',
        icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
      })
      if (req.method !== 'POST' || !['/chat', '/asr', '/ttsstream', '/tts'].includes(url.pathname)) throw new HttpError(404, 'not found')
      phase = url.pathname.slice(1)
      trace('req-start')
      if (url.pathname === '/asr') {
        const asrKey = cfg.raw.siliconflowKey || ''
        if (!asrKey) throw new HttpError(503, 'ASR is not configured (no key)')
        const wav = await readBody(req, 20 * 1024 * 1024, signal)
        if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new HttpError(400, 'expected WAV audio')
        const fd = new FormData()
        fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
        fd.append('model', cfg.asrModel)
        const up = await fetchUpstream('https://api.siliconflow.cn/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + asrKey }, body: fd })
        let data
        try { data = JSON.parse((await bufferedResponse(up, signal, 1024 * 1024, observeChunk)).toString('utf8')) }
        catch (error) { if (signal.aborted) throw signal.reason; throw new HttpError(502, 'invalid ASR response') }
        if (typeof data.text !== 'string') throw new HttpError(502, 'invalid ASR response')
        return sendJson(res, 200, { text: data.text.trim() })
      }
      const body = await readJson(req, signal)
      if (url.pathname === '/chat') {
        // 正式集成：ASR 文本由 App 送进当前 DSH 会话（工具/记忆/审批一致）。
        // 这里的独立 completions 只允许显式开启的过渡演示（config.standaloneChat），
        // 产品路径永不走它，避免出现第二套 LLM/历史。
        if (cfg.raw.standaloneChat !== true) throw new HttpError(410, 'voice chat runs through the DSH session, not this service')
        if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 || body.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 16000)) throw new HttpError(400, 'expected messages with user/assistant role and nonempty string content')
        const messages = body.messages.slice(-12).map(({ role, content }) => ({ role, content }))
        const up = await fetchUpstream('https://api.siliconflow.cn/v1/chat/completions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + cfg.raw.siliconflowKey, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.chatModel, messages: [{ role: 'system', content: SYSTEM }, ...messages], max_tokens: 320, temperature: 0.8, enable_thinking: false, stream: true }),
        })
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let pending = ''; let done = false
        const line = async raw => {
          const value = raw.trim()
          if (!value.startsWith('data:')) return
          const data = value.slice(5).trim()
          if (data === '[DONE]') { done = true; return }
          let item
          try { item = JSON.parse(data) } catch { throw new HttpError(502, 'invalid chat stream') }
          if (item.error) throw new HttpError(502, 'upstream chat error')
          const delta = item.choices?.[0]?.delta?.content
          if (delta !== undefined && delta !== null && typeof delta !== 'string') throw new HttpError(502, 'invalid chat token')
          if (delta) {
            if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
            await writeChunk(res, delta, signal)
          }
        }
        for await (const chunk of upstreamChunks(up, signal, observeChunk)) {
          pending += decoder.decode(chunk, { stream: true })
          let i
          while ((i = pending.indexOf('\n')) >= 0) {
            const raw = pending.slice(0, i); pending = pending.slice(i + 1)
            await line(raw)
            if (done) break
          }
          if (done) break
          if (pending.length > 65536) throw new HttpError(502, 'chat event too large')
        }
        if (!done) {
          pending += decoder.decode()
          if (pending.trim()) await line(pending)
          if (!done) throw new HttpError(502, 'incomplete chat stream')
        }
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(); return
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 600) throw new HttpError(400, 'expected nonempty text up to 600 characters')
      const streaming = url.pathname === '/ttsstream'
      const ttsBody = JSON.stringify({ text: body.text, model_id: cfg.ttsModel })
      const openTts = (base, voice, key) => fetchUpstream(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${streaming ? 'pcm' : 'mp3'}&sample_rate=${cfg.ttsSampleRate}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: ttsBody,
      })
      let up
      try {
        if (!cfg.ttsBase) throw new HttpError(503, 'TTS is not configured (no base)')
        up = await openTts(cfg.ttsBase, cfg.voiceId, cfg.ttsKey)
      } catch (primaryError) {
        // Optional secondary provider, configured entirely by the user.
        if (!cfg.raw.ttsFallbackBase) throw primaryError
        trace('tts-fallback', { reason: primaryError?.message || 'primary failed' })
        up = await openTts(cfg.raw.ttsFallbackBase, cfg.raw.ttsFallbackVoice || cfg.voiceId, cfg.raw.ttsFallbackKey || '')
      }
      if (streaming) {
        const srHeader = up.headers.get('x-sample-rate')
        if (srHeader && Number(srHeader) !== cfg.ttsSampleRate) {
          up.body?.cancel().catch(() => {})
          throw new HttpError(502, `tts sample rate ${srHeader} != expected ${cfg.ttsSampleRate}`)
        }
      }
      if (!streaming) {
        const audio = await bufferedResponse(up, signal, 16 * 1024 * 1024, observeChunk)
        if (!audio.length) throw new HttpError(502, 'empty TTS response')
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'no-store' }); res.end(audio); return
      }
      checkPcmType(up)
      let bytes = 0; let prefix = Buffer.alloc(0); let checked = false; let carry = Buffer.alloc(0)
      const emitPcm = async chunk => {
        const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
        const length = data.length - data.length % 2
        carry = data.subarray(length)
        if (!length) return
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-audio-format': 'pcm_s16le', 'x-audio-sample-rate': '24000', 'x-audio-channels': '1' })
        await writeChunk(res, data.subarray(0, length), signal)
      }
      for await (const chunk of upstreamChunks(up, signal, observeChunk)) {
        if (!chunk.length) continue
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) throw new HttpError(502, 'TTS response too large')
        const data = Buffer.from(chunk)
        if (!checked) {
          // At most 64 bytes held back; signatures may span arbitrarily split network chunks.
          const take = Math.min(64 - prefix.length, data.length)
          prefix = Buffer.concat([prefix, data.subarray(0, take)])
          if (prefix.length < 64) continue
          checkPcmPrefix(prefix); checked = true
          await emitPcm(prefix)
          await emitPcm(data.subarray(take))
        } else await emitPcm(data)
      }
      if (!bytes || bytes % 2) throw new HttpError(502, 'incomplete PCM audio')
      if (!checked) { checkPcmPrefix(prefix); await emitPcm(prefix) }
      res.end()
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error
      finishTrace(signal.aborted ? 'req-abort' : 'req-error', { status: failure instanceof HttpError ? failure.status : 502, reason: signal.aborted ? (failure?.status === 504 ? 'timeout' : 'disconnected') : (failure instanceof HttpError ? 'http_error' : 'upstream_error'), ...(failure?.retryAfter ? { retryAfter: Number(failure.retryAfter) } : {}) })
      controller.abort(failure)
      if (!res.headersSent) res.setHeader('connection', 'close')
      sendJson(res, failure instanceof HttpError ? failure.status : 502, { error: failure instanceof HttpError ? failure.message : 'upstream request failed', code: failure instanceof HttpError ? (failure.status === 400 ? 'BAD_REQUEST' : failure.status === 403 ? 'FORBIDDEN' : failure.status === 410 ? 'CHAT_DISABLED' : failure.status === 429 ? 'RATE_LIMIT' : failure.status === 504 ? 'TIMEOUT' : 'UPSTREAM') : 'INTERNAL' }, failure.retryAfter ? { 'retry-after': failure.retryAfter } : {})
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onTraceAbort)
      req.off('aborted', onError); req.off('error', onError)
      res.off('close', onDisconnect); res.off('error', onError)
    }
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 20_000
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy() })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Keys never ship inside the APK/source tree: the app/installer places the
  // config at VOICECALL_CONFIG (default /root/.dsh/voice/config.json). A missing
  // config is not fatal — /health still answers and ASR says "未配置".
  const configCandidates = [process.env.VOICECALL_CONFIG, '/root/.dsh/voice/config.json', join(HERE, 'config.json')].filter(Boolean)
  function loadConfig() {
    for (const candidate of configCandidates) {
      try {
        const stat = statSync(candidate)
        const value = JSON.parse(readFileSync(candidate, 'utf8'))
        return { ...value, __revision: `${Math.round(stat.mtimeMs)}:${stat.size}` }
      } catch (error) {
        if (error?.code !== 'ENOENT') return { __revision: 'invalid' }
      }
    }
    return { __revision: 'missing' }
  }
  const port = Number(process.env.VOICECALL_PORT || 3467)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid VOICECALL_PORT')
  // Diagnostics only (structured metadata, no transcript text). Lives under the
  // app's DSH home so it is cleaned with the user's data.
  const logger = createJsonlLogger({ path: process.env.VOICECALL_LOG || '/root/.dsh/voice/logs/events.jsonl' })
  const server = createVoiceServer({ config: loadConfig, logEvent: logger.logEvent })
  server.listen(port, '127.0.0.1', () => console.log(`voicecall ${VERSION} on http://127.0.0.1:${port}`))
  server.on('error', error => { console.error('voicecall listen error:', error.code || 'unknown'); process.exitCode = 1 })
  const stop = () => { server.close(); server.closeAllConnections(); setTimeout(() => process.exit(0), 1000).unref() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
}
