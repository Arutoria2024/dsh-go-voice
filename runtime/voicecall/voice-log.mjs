// Diagnostics are metadata only. Importing this module never creates files or starts I/O.
import { mkdir, stat, appendFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DIAGNOSTICS_LIMIT = 32 * 1024
export const DIAGNOSTICS_BATCH = 40
export const validVoiceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const phases = new Set(['idle', 'start', 'stop', 'request', 'recording', 'asr', 'chat', 'tts', 'ttsstream', 'download', 'decode', 'queue', 'playback', 'playing', 'drain', 'finish', 'error', 'abort', 'diagnostics', 'ready', 'resume', 'suspend', 'capture', 'vad', 'segment', 'flush', 'cleanup', 'connecting', 'listening', 'recognizing', 'generating', 'buffering', 'speaking', 'muted', 'ended'])
const numeric = ['at', 'time', 'segment', 'segmentIndex', 'segmentCount', 'elapsedMs', 'requestMs', 'firstByteMs', 'totalMs', 'audioMs', 'bytes', 'chars', 'tokens', 'count', 'seq', 'retryAfter', 'bufferedSeconds', 'playedFrames', 'framesSent', 'jobs', 'downloads', 'playbackCount']
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))

export function sanitizeClientEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || !token(event.kind)) return null
  const safe = { kind: event.kind }
  for (const key of ['pageId', 'turnId', 'requestId']) if (validVoiceId(event[key])) safe[key] = event[key]
  for (const key of numeric) if (finite(event[key])) safe[key] = event[key]
  if (iso(event.wallTime) || finite(event.wallTime)) safe.wallTime = event.wallTime
  if (phases.has(event.phase)) safe.phase = event.phase
  if (Number.isInteger(event.status) && event.status >= 0 && event.status <= 599) safe.status = event.status
  if (typeof event.active === 'boolean') safe.active = event.active
  for (const key of ['reason', 'errorName', 'errorCode']) if (token(event[key])) safe[key] = event[key]
  if (['suspended', 'running', 'closed', 'interrupted'].includes(event.ctxState)) safe.ctxState = event.ctxState
  if (['visible', 'hidden', 'prerender'].includes(event.visibility)) safe.visibility = event.visibility
  return safe
}

// Defense in depth at the disk boundary, even for callers other than the HTTP receiver.
function sanitizeStoredEvent(event) {
  const safe = sanitizeClientEvent(event)
  if (!safe) return null
  if (validVoiceId(event.clientRequestId)) safe.clientRequestId = event.clientRequestId
  if (event.source === 'client' || event.source === 'server') safe.source = event.source
  if (iso(event.serverAt)) safe.serverAt = event.serverAt
  if (typeof event.ct === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(event.ct) && event.ct.length <= 100) safe.ct = event.ct
  return safe
}

export function createJsonlLogger({ path = '/root/workspace/voicecall/logs/events.jsonl', maxBytes = 2 * 1024 * 1024, maxBacklog = 256, maxBacklogBytes = 256 * 1024, fs = { mkdir, stat, appendFile, rename } } = {}) {
  const queue = []
  let pendingBytes = 0; let running = false; let initialized = false; let size = 0; let dropped = 0
  const waiters = []
  const pump = async () => {
    if (running) return
    running = true
    while (queue.length) {
      const line = queue[0]
      const bytes = Buffer.byteLength(line)
      try {
        if (!initialized) {
          await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
          try { size = (await fs.stat(path)).size } catch (error) { if (error.code !== 'ENOENT') throw error; size = 0 }
          initialized = true
        }
        if (size + bytes > maxBytes) {
          await fs.rename(path, `${path}.1`).catch(error => { if (error.code !== 'ENOENT') throw error })
          size = 0
        }
        await fs.appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
        size += bytes
      } catch {
        // No external I/O failure, filename or error message escapes into speech requests.
        dropped++; initialized = false
      }
      queue.shift(); pendingBytes -= bytes
    }
    running = false
    for (const resolve of waiters.splice(0)) resolve()
  }
  const logEvent = event => {
    try {
      const safe = sanitizeStoredEvent(event)
      if (!safe) { dropped++; return false }
      const line = JSON.stringify(safe) + '\n'
      const bytes = Buffer.byteLength(line)
      if (bytes > maxBytes || queue.length >= maxBacklog || pendingBytes + bytes > maxBacklogBytes) { dropped++; return false }
      queue.push(line); pendingBytes += bytes
      void pump()
      return true
    } catch { dropped++; return false }
  }
  return { logEvent, flush: () => running ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(), stats: () => ({ pending: queue.length, pendingBytes, dropped }) }
}
