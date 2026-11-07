#!/usr/bin/env node
// Local speaker-verification sidecar (CAM++ / 3D-Speaker, Chinese), Node version.
// Uses the sherpa-onnx Node binding already bundled in the DSH runtime
// (/opt/dsh/node_modules), so no Python packages or extra APK size are needed.
// Loopback only. Returns a normalized 192-dim embedding; stores nothing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MODEL = process.env.VOICEPRINT_MODEL || path.join(HERE, 'models', 'campplus_zh_16k.onnx');
const PORT = Number(process.env.VOICEPRINT_PORT || 3459);
const ALLOW = process.env.VOICEPRINT_ORIGIN || 'http://127.0.0.1:3467';
const MAX = 3_000_000;

const require = createRequire(import.meta.url);
const { SpeakerEmbeddingExtractor } = require('sherpa-onnx-node/speaker-identification.js');

function readWav(buf) {
  let o = 12, ch = 1, sr = 16000, bits = 16, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const sz = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') { ch = buf.readUInt16LE(body + 2); sr = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
    else if (id === 'data') { data = buf.subarray(body, body + sz); break; }
    o = body + sz + (sz & 1);
  }
  if (!data || bits !== 16) throw new Error('bad-wav');
  const n = Math.floor(data.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2) / 32768;
  if (ch > 1) { const m = Math.floor(n / ch), y = new Float32Array(m); for (let i = 0; i < m; i++) { let s = 0; for (let c = 0; c < ch; c++) s += x[i * ch + c]; y[i] = s / ch; } return { sr, samples: y }; }
  return { sr, samples: x };
}
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), f = p - k; y[i] = (x[k] || 0) * (1 - f) + (x[Math.min(k + 1, x.length - 1)] || 0) * f; }
  return y;
}

console.log('loading CAM++ (node)…', process.env.VOICEPRINT_MODEL || MODEL);
const ext = new SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 2, debug: false, provider: 'cpu' });
const DIM = ext.dim || 192;
console.log('model ready dim=' + DIM);

function embed(samples16k) {
  const s = ext.createStream();
  s.acceptWaveform({ sampleRate: 16000, samples: samples16k });
  s.inputFinished();
  const e = ext.compute(s);
  let n = 0; for (let i = 0; i < e.length; i++) n += e[i] * e[i];
  n = Math.sqrt(n) || 1;
  const out = new Array(e.length);
  for (let i = 0; i < e.length; i++) out[i] = e[i] / n;
  return out;
}

const server = http.createServer((req, res) => {
  const cors = () => { res.setHeader('Access-Control-Allow-Origin', ALLOW); res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Vary', 'Origin'); };
  const json = (st, o) => { const b = JSON.stringify(o); cors(); res.writeHead(st, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  if (req.method === 'OPTIONS') { res.writeHead(204); cors(); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, model: 'campplus_zh_16k', dim: DIM, runtime: 'node' });
  if (req.method === 'POST' && req.url === '/embed') {
    const chunks = []; let size = 0, aborted = false;
    req.on('data', c => { size += c.length; if (size > MAX) { aborted = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (aborted) return json(413, { error: 'too large' });
      try {
        const wav = readWav(Buffer.concat(chunks));
        if (wav.samples.length < 1600) return json(400, { error: 'too short' });
        const s16 = resample(wav.samples, wav.sr, 16000);
        const e = embed(s16);
        return json(200, { ok: true, dim: e.length, embedding: e });
      } catch (err) { return json(400, { error: err.message || 'embed-failed' }); }
    });
    return;
  }
  json(404, { error: 'not found' });
});
server.listen(PORT, '127.0.0.1', () => console.log('voiceprint(node) on http://127.0.0.1:' + PORT));
