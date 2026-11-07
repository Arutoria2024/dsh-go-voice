// Explicit opt-in: exactly one short paid /chat and one short paid /ttsstream request.
// Never imported by the offline tests; never reads credentials/config.json.
import assert from 'node:assert/strict'
if (process.env.VOICECALL_REAL_SMOKE !== '1') throw new Error('Set VOICECALL_REAL_SMOKE=1 to explicitly allow two cloud requests')
const base = 'http://127.0.0.1:3457'
const health = await (await fetch(base + '/health')).json()
console.log('health:', JSON.stringify(health))
async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body), signal: AbortSignal.timeout(95_000) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${path} HTTP ${response.status}`) }
  return response
}
let failed = false
try {
  const chat = await post('/chat', { messages: [{ role: 'user', content: '只回复一个字：好' }] })
  const answer = new TextDecoder('utf-8', { fatal: true }).decode(await chat.arrayBuffer())
  assert(answer.trim()); assert(!answer.includes('\ufffd'))
  console.log('chat: HTTP 200, valid UTF8, chars=' + answer.length + ', text=' + JSON.stringify(answer))
} catch (error) { failed = true; console.error('chat smoke failed:', error.message) }
try {
  const tts = await post('/ttsstream', { text: '你好。' })
  const audio = Buffer.from(await tts.arrayBuffer())
  assert(audio.length > 0 && audio.length % 2 === 0)
  assert.equal(tts.headers.get('x-audio-sample-rate'), '24000')
  assert(!['RIFF', 'OggS'].includes(audio.toString('ascii', 0, 4)))
  assert.notEqual(audio.toString('ascii', 0, 3), 'ID3')
  console.log('ttsstream: HTTP 200, raw PCM16, bytes=' + audio.length + ', durationSeconds=' + (audio.length / 48000).toFixed(3))
} catch (error) { failed = true; console.error('ttsstream smoke failed:', error.message) }
assert.equal((await fetch(base + '/health')).status, 200)
if (failed) process.exitCode = 1
