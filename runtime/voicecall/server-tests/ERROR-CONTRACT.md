# 服务 2.0.2 错误契约与离线校验

运行所有离线测试：

```bash
node --check server.mjs
node --test server-tests/*.test.mjs
```

不要运行 smoke 脚本来验证此补丁；已有首次真实 chat / PCM smoke 结果可复用。本补丁测试完全依赖注入 mock 上游，不读取配置，不发起付费请求。

## 限流

上游 HTTP 429 在 `/chat`、`/asr`、`/ttsstream`、`/tts` 保留为 HTTP 429。JSON 错误只描述通用上游状态，不包含上游正文、密钥、URL或任意私有响应头。

唯一转译的上游响应头是 `Retry-After`：

- 下游总是规范整数秒字符串，范围 1–300。
- 接受上游非负整数字符串或严格 IMF-fixdate HTTP 日期。
- HTTP 日期换算为当前起剩余秒数、向上取整；过期日期最少1秒。
- 缺失/非法值默认5秒；超大合法秒数最多300秒。
- 后端不自动重试。前端可尊重此延迟，仍需自行设置重试次数/总时间上限，并在取消、挂断、会话变更时停止。

其他上游 HTTP 错误仍为502；总请求超时仍为504。流开始后的错误断开连接，不再输出第二个状态或 JSON/文字到音频流。

## PCM 保护

`/ttsstream` 只接受上游 `application/octet-stream`、`audio/pcm`、`audio/x-pcm`，可带参数；显式 rate/channels/bits 必须分别为24000/1/16。不把 `audio/L16`（网络大端序）冒充 little-endian PCM16。缺失类型、文本/HTML/JSON、容器/压缩媒体类型、非 identity Content-Encoding 均在流开始前502。

首最多64字节会暂存并跨任意网络 chunk 拼接，以检查 RIFF/RIFX/RF64/BW64 + WAVE、ID3、Ogg、FLAC、AIFF、CAF、AU、MP4、gzip/ZIP 等明确容器签名以及明确 HTML/XML/JSON 错误语法。2.0.2修正：孤立MP3/ADTS同步字也是合法PCM样本，不再据此前几个字节就返回502；只有观察到第二个一致压缩帧才按帧结构拒绝。短于64字节的响应在 EOF 后同样检查。没有凭“可打印字符”或“有效 UTF8”否定随机 PCM。原始PCM不自描述，前缀检查不是完备格式判别器。

已通过前缀校验后，持续按完整两个字节的采样值写入下游；网络 chunk 若留下1字节则暂存至下一 chunk。总长度为空或奇数时失败：首包前502；已经开始则断开流，末尾孤立字节不写出。音频类型和前缀检查是协议防错，不是通用音频解码器；原始 PCM 没有自描述头，采样率仍依赖已知上游契约，前端仍须将流截断视为失败。
