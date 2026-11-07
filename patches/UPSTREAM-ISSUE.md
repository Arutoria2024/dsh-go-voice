# 建议给 DSH-Go 原作者发的 Issue（草稿）

**仓库**：`ccch1mneyyy/dsh-go`
**标题**：社区语音模块分享：DSH-Go 实时语音通话（AGPL）

## 背景

我在 DSH-Go 上做了一套实时语音通话模块：麦克风 VAD → ASR → 当前 DSH 会话 →
流式 TTS → 边收边播，前端是 ChatGPT 风格的原生 Flutter 覆盖层（立绘/字幕/底部胶囊）。
已去掉私有配置和个人素材，按 AGPL-3.0 开源。

## 仓库

`https://github.com/Arutoria2024/dsh-go-voice`

## 功能说明

- ASR：SiliconFlow 兼容接口，默认 `Qwen/Qwen3-ASR-1.7B`，可配置
- 对话：复用当前 DSH 会话（模型/记忆/工具/审批一致）
- TTS：任意实现 `/v1/text-to-speech/{voice}/stream?output_format=pcm&sample_rate=24000` 的服务
- 播放层：当前用 WebView AudioWorklet 做真流式 PCM；**也希望后续官方播放层支持原生流式输出（AudioTrack MODE_STREAM）**，尤其解决后台/锁屏连续播放、首包缓冲和欠载恢复
- 语音服务只监听 `127.0.0.1`，校验 Host/Origin

## 说明

看到你已经做了类似的语音/Live2D 方向，我不打算重复造轮子；这个模块作为社区参考/备选发布。
本仓库不接受外部 PR 我理解，所以不提交 PR；如果不适合放在社区，直接关闭 issue 即可。

— 感谢 DSH-Go 的工作
