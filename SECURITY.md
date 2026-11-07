# Security

- Do not commit `config.json`, keystores, tokens or provider keys.
- The service only listens on loopback. Do not expose it to a LAN/public interface.
- Keys are stored app-private at `<rootfs>/root/.dsh/voice/config.json` (0600).
- Keep `android.permission.RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` on the
  application; do not remove them with manifest merger rules.
