import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where the ASR/TTS secrets live: Android Keystore-backed storage
/// (flutter_secure_storage), never SharedPreferences, the UI tree, logs or the
/// APK. Only the assembled JSON is handed to the guest config writer.
abstract class VoiceSecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureVoiceSecretStore implements VoiceSecretStore {
  SecureVoiceSecretStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static String _k(String key) => 'voice.$key';

  @override
  Future<String?> read(String key) => _storage.read(key: _k(key));
  @override
  Future<void> write(String key, String value) => _storage.write(key: _k(key), value: value);
  @override
  Future<void> delete(String key) => _storage.delete(key: _k(key));
}

/// What the settings page may show: presence only, never a value.
class VoiceServiceStatus {
  const VoiceServiceStatus({this.present = false, this.asr = false, this.tts = false, this.invalid = false});
  final bool present;
  final bool asr;
  final bool tts;
  final bool invalid;
}

/// The outcome of one save, shown verbatim: a failed write is never reported as
/// saved.
class VoiceConfigReceipt {
  const VoiceConfigReceipt.ok(this.message) : ok = true;
  const VoiceConfigReceipt.failed(this.message) : ok = false;
  final bool ok;
  final String message;
}

class VoiceConfigController extends Notifier<VoiceServiceStatus> {
  static const _channel = MethodChannel('dsh/voice');
  static const _asrKey = 'asr.key';
  static const _ttsKey = 'tts.key';
  static const _ttsBasePref = 'voice_tts_base';
  static const _ttsVoicePref = 'voice_tts_voice';

  late final VoiceSecretStore _secrets = SecureVoiceSecretStore();

  @override
  VoiceServiceStatus build() {
    unawaited(refresh());
    return const VoiceServiceStatus();
  }

  /// Open-source builds start with no credentials. Users configure ASR/TTS in
  /// 设置 → 语音; this hook remains for call sites that used to seed presets.
  Future<void> ensurePresets() async {
    await refresh();
  }

  Future<void> refresh() async {
    try {
      final map = await _channel.invokeMapMethod<String, Object?>('configStatus');
      if (!ref.mounted) return;
      state = VoiceServiceStatus(
        present: map?['present'] == true,
        asr: map?['asr'] == true,
        tts: map?['tts'] == true,
        invalid: map?['invalid'] == true,
      );
    } on MissingPluginException {
      // Desktop/tests: nothing to read.
    } on PlatformException {
      // Keep the last known state rather than inventing one.
    }
  }

  /// Saves the ASR key (or removes it with [remove]) and rewrites the guest
  /// config. Returns a receipt; only a 0600 write that the plugin confirmed
  /// counts as saved.
  Future<VoiceConfigReceipt> saveAsr({String? key, bool remove = false}) async {
    try {
      if (remove) {
        await _secrets.delete(_asrKey);
      } else {
        final trimmed = (key ?? '').trim();
        if (trimmed.isEmpty) return const VoiceConfigReceipt.failed('Key 不能为空');
        await _secrets.write(_asrKey, trimmed);
      }
      return await _writeConfig();
    } on PlatformException catch (e) {
      return VoiceConfigReceipt.failed('安全存储写入失败（${e.code}）');
    }
  }

  Future<VoiceConfigReceipt> saveTts({required String base, required String voice, String? key}) async {
    final trimmedBase = base.trim();
    if (trimmedBase.isEmpty) return const VoiceConfigReceipt.failed('服务地址不能为空');
    if (!trimmedBase.startsWith('https://') && !trimmedBase.startsWith('http://')) {
      return const VoiceConfigReceipt.failed('服务地址要以 http(s):// 开头');
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_ttsBasePref, trimmedBase);
      await prefs.setString(_ttsVoicePref, voice.trim());
    } catch (_) {
      return const VoiceConfigReceipt.failed('保存设置失败');
    }
    if (key != null) {
      final trimmedKey = key.trim();
      try {
        if (trimmedKey.isEmpty) {
          await _secrets.delete(_ttsKey);
        } else {
          await _secrets.write(_ttsKey, trimmedKey);
        }
      } on PlatformException catch (e) {
        return VoiceConfigReceipt.failed('安全存储写入失败（${e.code}）');
      }
    }
    return _writeConfig();
  }

  Future<VoiceConfigReceipt> clearTts() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_ttsBasePref);
      await prefs.remove(_ttsVoicePref);
    } catch (_) {
      return const VoiceConfigReceipt.failed('清除设置失败');
    }
    try {
      await _secrets.delete(_ttsKey);
    } on PlatformException catch (e) {
      return VoiceConfigReceipt.failed('安全存储删除失败（${e.code}）');
    }
    return _writeConfig();
  }

  /// The non-secret TTS halves already saved, so the dialog can open on what is
  /// configured instead of overwriting it. The key is never read back.
  Future<({String base, String voice})> savedTts() async {
    final prefs = await SharedPreferences.getInstance();
    return (base: prefs.getString(_ttsBasePref) ?? '', voice: prefs.getString(_ttsVoicePref) ?? '');
  }

  /// Builds the guest config from secure storage + non-secret preferences and
  /// writes it through the plugin (0600, app-private). Keys never leave this
  /// process except into that file.
  Future<VoiceConfigReceipt> _writeConfig() async {
    final asrKey = await _secrets.read(_asrKey);
    final ttsKey = await _secrets.read(_ttsKey);
    final prefs = await SharedPreferences.getInstance();
    final ttsBase = prefs.getString(_ttsBasePref) ?? '';
    final ttsVoice = prefs.getString(_ttsVoicePref) ?? '';
    final config = <String, Object?>{
      if ((asrKey ?? '').isNotEmpty) 'siliconflowKey': asrKey,
      if (ttsBase.isNotEmpty) 'ttsBase': ttsBase,
      if (ttsVoice.isNotEmpty) 'ttsVoice': ttsVoice,
      if ((ttsKey ?? '').isNotEmpty) 'ttsKey': ttsKey,
    };
    try {
      final result = await _channel.invokeMapMethod<String, Object?>('writeConfig', {'json': jsonEncode(config)});
      await refresh();
      if (result?['ok'] != true) {
        return const VoiceConfigReceipt.failed('配置没有写进引擎目录，请重试');
      }
      return const VoiceConfigReceipt.ok('已保存到本机引擎');
    } on MissingPluginException {
      return const VoiceConfigReceipt.failed('当前环境没有本机引擎');
    } on PlatformException catch (e) {
      return VoiceConfigReceipt.failed('写入失败（${e.code}）');
    }
  }
}

final voiceConfigProvider = NotifierProvider<VoiceConfigController, VoiceServiceStatus>(VoiceConfigController.new);
