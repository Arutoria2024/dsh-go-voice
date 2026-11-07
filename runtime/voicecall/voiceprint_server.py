#!/usr/bin/env python3
"""Local speaker-verification sidecar (CAM++ / 3D-Speaker, Chinese).
Loopback only, used by the voice test page to gate replies to the enrolled voice.
No audio is stored; only a 192-dim embedding is returned. Not bank-grade by itself,
but a real speaker model, far stronger than spectral heuristics.
"""
import json, os, sys, io, wave, threading
import numpy as np
from scipy.signal import resample_poly
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "campplus_zh_16k.onnx")
PORT = int(os.environ.get("VOICEPRINT_PORT", "3459"))
ALLOW_ORIGIN = os.environ.get("VOICEPRINT_ORIGIN", "http://127.0.0.1:3467")
MAX_BYTES = 3_000_000

print("loading CAM++ model…", flush=True)
ext = sherpa_onnx.SpeakerEmbeddingExtractor(
    sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=2, provider="cpu")
)
print("model ready", flush=True)
_lock = threading.Lock()

def embed_pcm(samples: np.ndarray, sr: int):
    if sr != 16000:
        g = np.gcd(int(sr), 16000)
        samples = resample_poly(samples, 16000 // g, sr // g).astype(np.float32)
    samples = samples.astype(np.float32)
    with _lock:
        s = ext.create_stream()
        s.accept_waveform(16000, samples)
        s.input_finished()
        emb = np.array(ext.compute(s), dtype=np.float32)
    n = float(np.linalg.norm(emb)) or 1.0
    return (emb / n).tolist()

def read_wav_bytes(data: bytes):
    with wave.open(io.BytesIO(data), "rb") as w:
        sr = w.getframerate(); ch = w.getnchannels(); sw = w.getsampwidth(); n = w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError("only 16-bit PCM")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Vary", "Origin")
    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self._cors(); self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": "campplus_zh_16k", "dim": 192})
        self._json(404, {"error": "not found"})
    def do_POST(self):
        if self.path != "/embed":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            return self._json(400, {"error": "bad length"})
        if n <= 0 or n > MAX_BYTES:
            return self._json(413, {"error": "too large or empty"})
        data = self.rfile.read(n)
        try:
            samples, sr = read_wav_bytes(data)
            if len(samples) < 1600:
                return self._json(400, {"error": "too short"})
            emb = embed_pcm(samples, sr)
            return self._json(200, {"ok": True, "dim": len(emb), "embedding": emb})
        except Exception as e:
            return self._json(400, {"error": type(e).__name__})
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"voiceprint sidecar on http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
