import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Settings for the realtime voice call (设置 → 语音 → 实时通话 / 声纹).
///
/// Only *behaviour* lives here and in SharedPreferences — never a key. ASR/TTS
/// keys belong to the Host's secure credential store; the values here are the
/// switches the person toggles.
class VoiceCallSettings {
  const VoiceCallSettings({
    this.callEnabled = true,
    this.handsFree = true,
    this.voiceprint = false,
    this.asrConfigured = false,
    this.ttsConfigured = false,
  });

  /// 启用实时通话. Off keeps the old dictation key on the composer.
  final bool callEnabled;

  /// 免提连续对话: keep listening after a reply (barge-in still works).
  final bool handsFree;

  /// 声纹录入（可选）— default OFF; only an on-device vector is kept.
  final bool voiceprint;

  /// Whether an ASR/TTS key is present in secure storage (status only, no value).
  final bool asrConfigured;
  final bool ttsConfigured;

  VoiceCallSettings copyWith({
    bool? callEnabled,
    bool? handsFree,
    bool? voiceprint,
    bool? asrConfigured,
    bool? ttsConfigured,
  }) => VoiceCallSettings(
    callEnabled: callEnabled ?? this.callEnabled,
    handsFree: handsFree ?? this.handsFree,
    voiceprint: voiceprint ?? this.voiceprint,
    asrConfigured: asrConfigured ?? this.asrConfigured,
    ttsConfigured: ttsConfigured ?? this.ttsConfigured,
  );
}

class VoiceCallSettingsController extends Notifier<VoiceCallSettings> {
  static const _callKey = 'voice_call_enabled';
  static const _handsFreeKey = 'voice_call_handsfree';
  static const _voiceprintKey = 'voice_call_voiceprint';
  late Future<void> _loaded;

  @override
  VoiceCallSettings build() {
    _loaded = _load();
    return const VoiceCallSettings();
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!ref.mounted) return;
      state = state.copyWith(
        callEnabled: prefs.getBool(_callKey) ?? true,
        handsFree: prefs.getBool(_handsFreeKey) ?? true,
        // Voiceprint can never silently become on from a stale default.
        voiceprint: prefs.getBool(_voiceprintKey) ?? false,
      );
    } catch (_) {
      // Unreadable preferences: keep the safe defaults (call off, voiceprint off).
    }
  }

  Future<VoiceCallSettings> ready() async {
    await _loaded;
    return ref.mounted ? state : const VoiceCallSettings();
  }

  Future<void> setCallEnabled(bool value) async {
    await _loaded;
    if (!ref.mounted) return;
    state = state.copyWith(callEnabled: value);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_callKey, value);
  }

  Future<void> setHandsFree(bool value) async {
    await _loaded;
    if (!ref.mounted) return;
    state = state.copyWith(handsFree: value);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_handsFreeKey, value);
  }

  Future<void> setVoiceprint(bool value) async {
    await _loaded;
    if (!ref.mounted) return;
    state = state.copyWith(voiceprint: value);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_voiceprintKey, value);
  }

  Future<void> setServiceStatus({bool? asr, bool? tts}) async {
    if (!ref.mounted) return;
    state = state.copyWith(asrConfigured: asr, ttsConfigured: tts);
  }
}

final voiceCallSettingsProvider = NotifierProvider<VoiceCallSettingsController, VoiceCallSettings>(
  VoiceCallSettingsController.new,
);
