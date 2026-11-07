#!/bin/sh
# Starts the local realtime-voice service inside the app's Linux runtime.
# Loopback only (127.0.0.1:3467). Keys never live here: server.mjs reads the
# config from $VOICECALL_CONFIG (default /root/.dsh/voice/config.json), which the
# app writes from its secure storage. Missing config is not fatal — /health
# still answers and ASR reports "未配置" until the person saves a key.
set -u
ROOT=$(dirname -- "$0")
PORT="${VOICECALL_PORT:-3467}"
CONFIG="${VOICECALL_CONFIG:-/root/.dsh/voice/config.json}"
export VOICECALL_PORT="$PORT" VOICECALL_CONFIG="$CONFIG"
# Optional speaker-verification sidecar (CAM++). Prefer the Node implementation,
# which reuses the sherpa-onnx bundled in the DSH runtime (no Python, no extra size).
if [ -f "$ROOT/models/campplus_zh_16k.onnx" ]; then
  NODE_BIN=/opt/node/bin/node
  if [ -x "$NODE_BIN" ] && NODE_PATH=/opt/dsh/node_modules "$NODE_BIN" -e "require('sherpa-onnx-node/speaker-identification.js')" >/dev/null 2>&1; then
    NODE_PATH=/opt/dsh/node_modules LD_LIBRARY_PATH="/opt/dsh/node_modules/sherpa-onnx-linux-arm64:${LD_LIBRARY_PATH:-}" \
      VOICEPRINT_PORT="${VOICEPRINT_PORT:-3459}" "$NODE_BIN" "$ROOT/voiceprint_server.mjs" >/tmp/dsh-go-voiceprint.log 2>&1 &
  elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sherpa_onnx' >/dev/null 2>&1; then
    VOICEPRINT_PORT="${VOICEPRINT_PORT:-3459}" python3 "$ROOT/voiceprint_server.py" >/tmp/dsh-go-voiceprint.log 2>&1 &
  fi
fi
# Restart on unexpected exit (not on SIGTERM): keeps 3467 alive across a crash.
while :; do
  /opt/node/bin/node "$ROOT/server.mjs" || true
  # If node exits right away repeatedly we still back off a little.
  sleep 2
done
