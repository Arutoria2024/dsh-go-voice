# Architecture

```
Flutter VoiceCallOverlay (native)
  ├─ avatar / captions / bottom capsule
  ├─ invisible WebView → http://127.0.0.1:3467/
  └─ JS bridges: DshVoiceAsk (text→Dart), DshVoiceState (phase/level/caption/detail→Dart)

runtime/voicecall (Node 24, loopback only)
  ├─ /asr        WAV → SiliconFlow-compatible transcription
  ├─ /ttsstream  text → TTS provider → bare PCM 24k mono s16le → chunked response
  ├─ /tts        text → MP3 (legacy/short replies)
  ├─ /health     public config (no secrets) + configRevision
  └─ /diagnostics bounded, sanitised client traces
```

## Voice turn

1. `getUserMedia` → AudioWorklet/ScriptProcessor → energy VAD.
2. Speech end → 16 kHz mono WAV → `/asr`.
3. Recognised text goes through the existing `DshVoiceAsk` bridge into the
   current DSH session (`ChatController.send`, queue mode).
4. Assistant deltas are forwarded to the page **only from the current turn's
   item index**; old history is never replayed into TTS.
5. Reply text is split at sentence boundaries → `/ttsstream` → PCM chunks →
   AudioWorklet playback (falls back to `ScriptProcessor` when AudioWorklet is
   unavailable).
6. Playback level drives the avatar/captions; `stop` increments a generation and
   aborts every upstream request.

## Config hot reload

`server.mjs` reads `VOICECALL_CONFIG` (or `/root/.dsh/voice/config.json`) per
request with an mtime cache; `/health` exposes a non-secret `configRevision`.
Changing ASR/TTS settings does not require restarting the service.

## Known boundary

This module uses the WebView AudioWorklet as its streaming player. It is true
streaming on the normal path, but a hidden WebView stops when the app goes to
the background/locks. A native `AudioTrack MODE_STREAM` player is a natural next
step if background calls are required.
