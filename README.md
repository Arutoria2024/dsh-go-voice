<!-- markdownlint-disable -->

<div align="center">

<img alt="LOGO" src="./assets/voice/mascot.webp" width="180" height="180" />

# DSH-Go Voice

<br>

<div>
  <img alt="Flutter" src="https://img.shields.io/badge/Flutter-3.47-02569B?logo=flutter&logoColor=white">
  <img alt="Dart" src="https://img.shields.io/badge/Dart-3.13-0175C2?logo=dart&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white">
  <img alt="platform" src="https://img.shields.io/badge/platform-Android-blueviolet">
</div>
<div>
  <img alt="license" src="https://img.shields.io/github/license/Arutoria2024/dsh-go-voice">
  <img alt="commit" src="https://img.shields.io/github/commit-activity/m/Arutoria2024/dsh-go-voice?color=%23ff69b4">
  <img alt="stars" src="https://img.shields.io/github/stars/Arutoria2024/dsh-go-voice?style=social">
</div>

<!-- markdownlint-restore -->

[简体中文](README.md) | [English](README.en.md)

**DSH-Go 实时语音通话模块**

为 [DSH-Go](https://github.com/ccch1mneyyy/dsh-go) 提供 ChatGPT 风格的实时语音通话：
点电话 → 立绘/字幕浮入 → 说话 → ASR → 当前 DSH 会话 → 流式 TTS → 边收边播。

不是独立 App，**作为 DSH-Go 的语音模块/补丁使用**。

</div>

## 亮点功能

- **同一会话**：声音识别后进入当前 DSH 会话，和打字共用模型、记忆、工具与审批
- **实时流式 TTS**：裸 PCM `24 kHz / mono / s16le`，边收边播，按播放进度驱动立绘与字幕
- **本地 VAD**：16 kHz WAV + 能量端点检测，说完自动提交；无麦克风图标，点中间立绘继续
- **ChatGPT 风格覆盖层**：全屏原生 Flutter UI，聊天页缩放模糊、立绘随真实 RMS 呼吸、字幕流式
- **底部输入胶囊**：`[+] [询问 DeepSeek] [✕]`，可手动打字；`+` 走系统附件选择器
- **可配置 provider**：ASR 用 SiliconFlow 兼容接口，TTS 接任意实现 `/v1/text-to-speech/{voice}/stream` 的服务
- **loopback-only**：语音服务只监听 `127.0.0.1`，校验 Host/Origin，不暴露到局域网/公网

## 下载与安装

## 下载

- [GitHub Releases v1.0.0](https://github.com/Arutoria2024/dsh-go-voice/releases/tag/v1.0.0)
  - `DSH-Go-voice-open-arm64.apk`：公开测试 APK（arm64，**未内置任何 key**，首次使用请在语音设置里配置 ASR/TTS）
  - `DSH-Go-voice-open-source-full-20261107.tar.gz`：完整可编译源码
  - `dsh-go-voice-open-source-20261107.tar.gz`：独立语音模块源码

本仓库包含**完整魔改源码**（`app/`、`packages/`、`runtime/`、`tooling/`）和语音模块；Release 里的 APK 是公开测试包。接入/构建请先准备 [DSH-Go](https://github.com/ccch1mneyyy/dsh-go) 对应版本，再按 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [patches/INTEGRATION.md](patches/INTEGRATION.md)：

1. `runtime/voicecall/` → DSH-Go 的 `runtime/voicecall/`
2. `app/lib/` / `app/android/.../voice/` → 对应路径
3. `pubspec.yaml` 增加 `assets/voice/`
4. `AndroidManifest.xml` 保留 `RECORD_AUDIO` 与 `MODIFY_AUDIO_SETTINGS`

## 路线图 / 播放层

- **当前**：播放层用 WebView `AudioWorklet` 做真流式 PCM（正常路径边收边播，按播放进度驱动字幕/RMS）。
- **下一版目标**：原生 `AudioTrack MODE_STREAM` 播放层（24 kHz mono s16le），支持后台/锁屏连续播放、首包缓冲、欠载恢复、`stop` 中断上游、失败回退整段；同时保留浏览器/WebView 等价流式回退。
- 如果你在集成时只需要评估语音链路，可先用当前 AudioWorklet 版本；若要做“锁屏也能聊”的成品，原生播放层是必须的。

## 使用说明

### 配置 ASR / TTS

密钥不写入源码。运行后在 App 的「语音设置」里填写，或写入运行时私有文件：

```json
{
  "siliconflowKey": "<ASR key>",
  "asrModel": "Qwen/Qwen3-ASR-1.7B",
  "ttsBase": "https://your-tts.example.com",
  "ttsVoice": "default",
  "ttsModel": "default",
  "ttsKey": "",
  "ttsSampleRate": 24000
}
```

TTS 服务需实现：

```
POST {ttsBase}/v1/text-to-speech/{voice}/stream?output_format=pcm&sample_rate=24000
Content-Type: application/json

{"text":"...","model_id":"..."}

→ 200 audio/pcm | application/octet-stream
  24 kHz, mono, s16le, bare PCM（无 WAV 头）
```

### 语音流程

`麦克风 → VAD → /asr → /chat(当前会话) → /ttsstream → PCM → AudioWorklet 播放`

详细数据流、配置热读、回合隔离与已知边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 加入我们

### 参与开发

欢迎提交 Issue / PR。接入新 DSH-Go 版本时，重点核对：
`ChatController.send` 的 `SendMode`、`ChatState.items` 的 `AssistantChatItem` 结构、
`webview_flutter`/`webview_flutter_android` 的权限 API。改动请附带 `flutter analyze` 结果。

### 主要依赖

- [DSH-Go](https://github.com/ccch1mneyyy/dsh-go) / [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Flutter](https://flutter.dev/) / [webview_flutter](https://pub.dev/packages/webview_flutter)
- [SiliconFlow ASR](https://siliconflow.cn/)（模型可配置）
- Node.js 24（语音代理服务）

## 致谢

感谢 DSH-Go 作者 [@ccch1mneyyy](https://github.com/ccch1mneyyy) 提供优秀的手机端 DSH 客户端；
感谢 DeepSeek Harness、Flutter、webview_flutter 及 SiliconFlow 等开源/开放服务。

本项目的占位立绘与提示音为仓库自生成素材，不包含任何第三方角色原画或录屏音频。

## 声明

- 本项目使用 **GNU Affero General Public License v3.0 only** 开源（见 [LICENSE](LICENSE)）。
- 本项目是 DSH-Go 的社区模块，**非 DSH-Go 官方项目**；DSH-Go 本身的版权归其作者所有。
- 本项目开源、免费，仅供学习交流；请自行配置并遵守所用 ASR/TTS 服务商条款。
- 不得将本项目用于任何违法用途；使用第三方角色素材前请确认其授权。
