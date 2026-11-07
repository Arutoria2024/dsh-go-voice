<div align="center">

<img alt="LOGO" src="./assets/voice/mascot.webp" width="180" height="180" />

# DSH-Go Voice

**Realtime voice-call module for DSH-Go** — ChatGPT-style voice mode inside the chat page:
tap the phone key, speak, and the recognised text goes through the current DSH session;
the reply streams back as PCM and plays while the avatar and captions react to the audio.

[简体中文](README.md) | English

</div>

## Features

- Same DSH session as typing: model, memory, tools and approvals are shared.
- Streaming TTS: bare PCM `24 kHz / mono / s16le`, played as it arrives.
- Local VAD + 16 kHz WAV ASR; tap the mascot to resume.
- Native Flutter overlay with a bottom capsule `[+] [Ask DeepSeek] [✕]`.
- Configurable ASR (SiliconFlow-compatible) and TTS (`/v1/text-to-speech/{voice}/stream`).
- Loopback-only voice service; no keys in source.

## Install

This repository is a **source module**, not a standalone APK. Follow
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [patches/INTEGRATION.md](patches/INTEGRATION.md)
to integrate it into a DSH-Go checkout.

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
