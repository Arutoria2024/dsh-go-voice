# Integration notes

Files copied from the reference integration:

- `app/lib/ui/chat/voice_call_page.dart` — overlay, mascot tap-to-resume,
  WebView bridges, typed-send and error-detail plumbing.
- `app/lib/state/voice_config_state.dart` — secure-store keys and config write.
- `app/lib/state/voice_call_settings.dart` — callEnabled/handsFree/voiceprint flags.
- `app/lib/ui/chat/composer.dart` — phone key (right of the dictation mic).
- `app/lib/ui/chat/chat_screen.dart` — `VoiceCallOverlay` mounted in chat `Stack`.
- `app/lib/ui/web/web_mic_policy.dart` — voiceCallOrigin/voiceCallUrl.
- `app/android/.../voice/*.kt` — permission, config, diagnostics and WAV recorder.

Diff these against your DSH-Go version instead of replacing files blindly; upstream
changes `chat_screen.dart`/`composer.dart` frequently. Keep AGPL headers/notices.
