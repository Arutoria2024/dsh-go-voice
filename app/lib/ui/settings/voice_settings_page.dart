import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/voice_call_settings.dart';
import '../../state/voice_config_state.dart';
import '../../state/voice_model_state.dart';
import '../../state/voice_settings.dart';
import '../common/app_dialog.dart';
import '../shell/page_frame.dart';
import '../theme/app_icons.dart';
import '../theme/theme.dart';
import 'settings_widgets.dart';

String voiceModeLabel(L10n l10n, VoiceMode mode) => switch (mode) {
  VoiceMode.auto => l10n.voiceModeAuto,
  VoiceMode.system => l10n.voiceModeSystem,
  VoiceMode.engine => l10n.voiceModeEngine,
};

/// The model's name as its authors write it (not translated).
const voiceModelName = 'SenseVoice'; // l10n:keep model name

/// Why a model download stopped, as one short sentence.
String voiceModelFailureText(L10n l10n, VoiceModelFailure? failure, {int? neededBytes}) => switch (failure) {
  VoiceModelFailure.network => l10n.voiceModelFailNetwork,
  VoiceModelFailure.timeout => l10n.voiceModelFailTimeout,
  VoiceModelFailure.certificate => l10n.voiceModelFailCertificate,
  VoiceModelFailure.server => l10n.voiceModelFailServer,
  VoiceModelFailure.integrity => l10n.voiceModelFailIntegrity,
  VoiceModelFailure.storage => l10n.voiceModelFailStorage(voiceModelMegabytes(neededBytes ?? voiceModelDefaultBytes)),
  VoiceModelFailure.engine => l10n.voiceModelFailEngine,
  VoiceModelFailure.unknown || null => l10n.voiceModelFailUnknown,
};

/// A download the person asked for: the card's 下载, 继续下载, 重试 and 重新下载
/// ([again]: the whole model comes again) and the failure notice's 重试. All of
/// them ask the same way before using mobile data. (The download chosen during
/// setup, and one going on after the app was killed, start by themselves: the
/// size was shown when the person chose it.)
Future<void> downloadVoiceModel(BuildContext context, WidgetRef ref, {bool again = false}) async {
  final controller = ref.read(voiceModelProvider.notifier);
  if (await controller.metered()) {
    if (!context.mounted) return;
    final model = ref.read(voiceModelProvider);
    final left = again ? model.totalBytes : (model.totalBytes - model.doneBytes).clamp(0, model.totalBytes);
    final l10n = context.l10n;
    final ok = await showAppDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(l10n.voiceModelMeteredTitle),
        content: Text(l10n.voiceModelMeteredBody(voiceModelMegabytes(left == 0 ? model.totalBytes : left))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(l10n.commonCancel)),
          FilledButton(
            key: const ValueKey('voice-model-metered-ok'),
            onPressed: () => Navigator.pop(dialog, true),
            child: Text(l10n.voiceModelDownload),
          ),
        ],
      ),
    );
    if (ok != true) return;
  }
  await (again ? controller.redownload() : controller.download());
}

class VoiceSettingsTile extends ConsumerWidget {
  const VoiceSettingsTile({super.key, this.tint = 0});
  final int tint;

  @override
  Widget build(BuildContext context, WidgetRef ref) => SettingsTile(
    key: const ValueKey('settings-voice'),
    icon: AppIcons.voice,
    tint: tint,
    spot: SettingsIndex.entry(SettingsPageId.voice),
    value: Text(voiceModeLabel(context.l10n, ref.watch(voiceSettingsProvider))),
    onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const VoiceSettingsPage())),
  );
}

class VoiceSettingsPage extends ConsumerStatefulWidget {
  const VoiceSettingsPage({super.key});

  @override
  ConsumerState<VoiceSettingsPage> createState() => _VoiceSettingsPageState();
}

class _VoiceSettingsPageState extends ConsumerState<VoiceSettingsPage> {
  @override
  void initState() {
    super.initState();
    // What is on disk may have changed since the controller last looked.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(ref.read(voiceModelProvider.notifier).refresh());
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final selected = ref.watch(voiceSettingsProvider);
    final call = ref.watch(voiceCallSettingsProvider);
    final callCtl = ref.read(voiceCallSettingsProvider.notifier);
    final svc = ref.watch(voiceConfigProvider);
    return AppPage.list(
      title: l10n.voiceSettingsTitle,
      children: [
        SettingsSection(
          title: l10n.voiceModeSection,
          children: [
            for (final mode in VoiceMode.values)
              Semantics(
                checked: selected == mode,
                inMutuallyExclusiveGroup: true,
                child: SettingsTile(
                  key: ValueKey('voice-mode-${mode.name}'),
                  title: voiceModeLabel(l10n, mode),
                  subtitle: switch (mode) {
                    VoiceMode.auto => l10n.voiceModeAutoHint,
                    VoiceMode.system => l10n.voiceModeSystemHint,
                    VoiceMode.engine => l10n.voiceModeEngineHint,
                  },
                  trailing: SizedBox.square(
                    dimension: 32,
                    child: Icon(selected == mode ? AppIcons.radioOn : AppIcons.radioOff, size: 24),
                  ),
                  onTap: () => unawaited(ref.read(voiceSettingsProvider.notifier).setMode(mode)),
                ),
              ),
          ],
        ),
        SettingsSection(
          title: l10n.voiceModelSection,
          footer: Text(l10n.voiceModelFooter),
          children: const [VoiceModelCard()],
        ),
        // Below the existing sections on purpose: the page's golden tests cover
        // the viewport above, and the call settings are new surface, not a
        // re-layout of the dictation settings.
        SettingsSection(
          title: l10n.voiceCallSection,
          footer: Text(l10n.voiceCallEnableHint),
          children: [
            SettingsTile(
              key: const ValueKey('voice-call-enable'),
              icon: AppIcons.call,
              title: l10n.voiceCallEnable,
              subtitle: call.callEnabled ? l10n.voiceCallHandsFree : null,
              trailing: Switch(
                value: call.callEnabled,
                onChanged: (v) => unawaited(callCtl.setCallEnabled(v)),
              ),
            ),
            if (call.callEnabled) ...[
              SettingsTile(
                key: const ValueKey('voice-call-handsfree'),
                icon: AppIcons.voice,
                title: l10n.voiceCallHandsFree,
                subtitle: l10n.voiceCallHandsFreeHint,
                trailing: Switch(
                  value: call.handsFree,
                  onChanged: (v) => unawaited(callCtl.setHandsFree(v)),
                ),
              ),
              SettingsTile(
                key: const ValueKey('voice-call-model'),
                icon: AppIcons.voice,
                title: l10n.voiceCallModel,
                subtitle: l10n.voiceCallModelHint,
                value: Text(l10n.voiceCallModelValue),
              ),
            ],
          ],
        ),
        SettingsSection(
          title: l10n.voiceServiceSection,
          footer: Text('${l10n.voiceServiceHint}\n${l10n.voicePrivacyNote}'),
          children: [
            SettingsTile(
              key: const ValueKey('voice-asr-service'),
              icon: AppIcons.voice,
              title: l10n.voiceAsrService,
              subtitle: svc.asr ? l10n.voiceServiceKeyStored : l10n.voiceServiceKeyMissing,
              value: Text(svc.asr ? l10n.voiceServiceConfigured : l10n.voiceServiceUnconfigured),
              onTap: () => _editAsr(context, ref),
            ),
            SettingsTile(
              key: const ValueKey('voice-tts-service'),
              icon: AppIcons.voice,
              title: l10n.voiceTtsService,
              subtitle: svc.tts ? l10n.voiceServiceConfigured : l10n.voiceServiceKeyMissing,
              value: Text(svc.tts ? l10n.voiceServiceConfigured : l10n.voiceServiceUnconfigured),
              onTap: () => _editTts(context, ref),
            ),
          ],
        ),
        SettingsSection(
          title: l10n.voiceVoiceprint,
          footer: Text(l10n.voiceVoiceprintHint),
          children: [
            SettingsTile(
              key: const ValueKey('voice-voiceprint-enable'),
              icon: AppIcons.voice,
              title: l10n.voiceVoiceprint,
              subtitle: call.voiceprint ? l10n.voiceVoiceprintEnrolled : l10n.voiceVoiceprintNone,
              trailing: Switch(
                value: call.voiceprint,
                onChanged: (v) => unawaited(callCtl.setVoiceprint(v)),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// The model's status, progress and actions, inside the settings card.
class VoiceModelCard extends ConsumerWidget {
  const VoiceModelCard({super.key});

  /// Card edge → content, on all four sides.
  static const padding = EdgeInsets.fromLTRB(SettingsMetrics.inset, 14, SettingsMetrics.inset, SettingsMetrics.inset);

  /// Between two buttons in a row.
  static const buttonGap = 12.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final colors = DshColors.of(context);
    final model = ref.watch(voiceModelProvider);
    final controller = ref.read(voiceModelProvider.notifier);
    final total = voiceModelMegabytes(model.totalBytes);
    final partial = model.doneBytes > 0 && model.doneBytes < model.totalBytes;

    final (status, statusColor) = switch (model.status) {
      VoiceModelStatus.waiting => (l10n.voiceModelWaiting, colors.textTertiary),
      VoiceModelStatus.unsupported => (l10n.voiceModelUnsupported, colors.textTertiary),
      VoiceModelStatus.absent => (l10n.voiceModelAbsent, theme.colorScheme.onSurfaceVariant),
      VoiceModelStatus.downloading => (
        '${((model.fraction ?? 0) * 100).floor()}%',
        theme.colorScheme.onSurfaceVariant,
      ),
      VoiceModelStatus.preparing => (l10n.voiceModelPreparing, theme.colorScheme.onSurfaceVariant),
      VoiceModelStatus.ready => (l10n.voiceModelReady, colors.success),
      VoiceModelStatus.failed => (l10n.voiceModelFailed, colors.danger),
    };
    final note = switch (model.status) {
      VoiceModelStatus.downloading => l10n.voiceModelBytes(voiceModelMegabytes(model.doneBytes), total),
      VoiceModelStatus.preparing => null,
      VoiceModelStatus.ready => l10n.voiceModelReadyNote(total),
      VoiceModelStatus.failed => voiceModelFailureText(l10n, model.failure, neededBytes: model.neededBytes),
      VoiceModelStatus.waiting when model.wanted => l10n.voiceModelWaitingNote,
      VoiceModelStatus.absent || VoiceModelStatus.waiting when partial => l10n.voiceModelBytes(
        voiceModelMegabytes(model.doneBytes),
        total,
      ),
      VoiceModelStatus.absent || VoiceModelStatus.waiting => l10n.voiceModelAbsentNote(total),
      VoiceModelStatus.unsupported => null,
    };

    (String, Widget) primary(String label, VoidCallback onPressed, {Key? key}) =>
        (label, FilledButton(key: key, onPressed: onPressed, child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis)));
    (String, Widget) secondary(String label, VoidCallback onPressed, {Key? key, bool danger = false}) => (
      label,
      OutlinedButton(
        key: key,
        onPressed: onPressed,
        style: danger ? OutlinedButton.styleFrom(foregroundColor: colors.danger) : null,
        child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    );

    final List<(String, Widget)> actions = switch (model.status) {
      VoiceModelStatus.unsupported => const [],
      VoiceModelStatus.waiting when model.wanted => [
        secondary(l10n.commonCancel, () => unawaited(controller.cancel()), key: const ValueKey('voice-model-cancel')),
      ],
      VoiceModelStatus.absent || VoiceModelStatus.waiting => [
        primary(
          partial ? l10n.voiceModelResume : l10n.voiceModelDownload,
          () => unawaited(downloadVoiceModel(context, ref)),
          key: const ValueKey('voice-model-download'),
        ),
      ],
      VoiceModelStatus.downloading || VoiceModelStatus.preparing => [
        secondary(l10n.commonCancel, () => unawaited(controller.cancel()), key: const ValueKey('voice-model-cancel')),
      ],
      VoiceModelStatus.ready => [
        secondary(
          l10n.voiceModelRedownload,
          () => unawaited(downloadVoiceModel(context, ref, again: true)),
          key: const ValueKey('voice-model-redownload'),
        ),
        secondary(
          l10n.commonDelete,
          () => unawaited(_delete(context, ref)),
          key: const ValueKey('voice-model-delete'),
          danger: true,
        ),
      ],
      VoiceModelStatus.failed => [
        primary(l10n.commonRetry, () => unawaited(downloadVoiceModel(context, ref)), key: const ValueKey('voice-model-retry')),
      ],
    };
    final buttons = [for (final (_, b) in actions) b];
    final labels = [for (final (l, _) in actions) l];

    return Padding(
      key: const ValueKey('voice-model-card'),
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            // The name on the left edge, the status flush with the right one.
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(voiceModelName, style: settingsTitleStyle(context)),
              const SizedBox(width: 12),
              Flexible(
                child: Text(
                  status,
                  key: const ValueKey('voice-model-status'),
                  textAlign: TextAlign.end,
                  style: theme.textTheme.bodyMedium?.copyWith(color: statusColor),
                ),
              ),
            ],
          ),
          if (model.busy) ...[
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: AppShape.radiusXs,
              child: LinearProgressIndicator(
                key: const ValueKey('voice-model-progress'),
                value: model.status == VoiceModelStatus.downloading ? model.fraction : null,
                minHeight: 4,
              ),
            ),
          ],
          if (note != null) ...[
            SizedBox(height: model.busy ? 8 : 4),
            Text(
              note,
              key: const ValueKey('voice-model-note'),
              style: theme.textTheme.bodySmall?.copyWith(color: colors.textTertiary),
            ),
          ],
          if (buttons.isNotEmpty) ...[
            const SizedBox(height: 14),
            _Actions(key: const ValueKey('voice-model-actions'), labels: labels, children: buttons),
          ],
        ],
      ),
    );
  }

  static Future<void> _delete(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final ok = await showAppDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(l10n.voiceModelDeleteTitle),
        content: Text(l10n.voiceModelDeleteBody),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(l10n.commonCancel)),
          FilledButton(
            key: const ValueKey('voice-model-delete-ok'),
            style: FilledButton.styleFrom(
              backgroundColor: DshColors.of(dialog).danger,
              foregroundColor: DshColors.of(dialog).onDanger,
            ),
            onPressed: () => Navigator.pop(dialog, true),
            child: Text(l10n.commonDelete),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final controller = ref.read(voiceModelProvider.notifier);
    final deleted = await controller.delete();
    if (!deleted && context.mounted) {
      // A download that has not stopped yet: nothing was touched, later works.
      final text = controller.downloadStopping ? l10n.voiceModelDeleteStopping : l10n.voiceModelDeleteFailed;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
    }
  }
}

/// One or two equal-width buttons: side by side when every label fits its
/// half, otherwise stacked full width (narrow screens, large text).
class _Actions extends StatelessWidget {
  const _Actions({super.key, required this.labels, required this.children});

  final List<String> labels;
  final List<Widget> children;

  /// A Material 3 button's own side padding, both sides.
  static const _buttonPadding = 48.0;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final style = Theme.of(context).textTheme.labelLarge;
      final scaler = MediaQuery.textScalerOf(context);
      final half = (constraints.maxWidth - VoiceModelCard.buttonGap) / 2;
      final fits =
          children.length < 2 ||
          labels.every((label) {
            final painter = TextPainter(
              text: TextSpan(text: label, style: style),
              textDirection: Directionality.of(context),
              textScaler: scaler,
              maxLines: 1,
            )..layout();
            final width = painter.width;
            painter.dispose();
            return width + _buttonPadding <= half;
          });
      if (fits) {
        return Row(
          children: [
            for (final (i, button) in children.indexed) ...[
              if (i > 0) const SizedBox(width: VoiceModelCard.buttonGap),
              Expanded(child: button),
            ],
          ],
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        spacing: 8,
        children: children,
      );
    },
  );
}

/// The two TTS providers the dialog offers, each with its own defaults.
enum _TtsVendor { cloud, lan }

const _ttsVendorDefaults = {
  _TtsVendor.cloud: (base: 'https://your-tts.example.com', voice: 'default'),
  _TtsVendor.lan: (base: 'http://192.168.1.10:9880', voice: 'default'),
};

/// ASR: one hidden key field. The value is never read back into the UI.
Future<void> _editAsr(BuildContext context, WidgetRef ref) async {
  final l10n = context.l10n;
  final controller = TextEditingController();
  final receipt = await showDialog<VoiceConfigReceipt?>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(l10n.voiceAsrService),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'ASR 服务商：SiliconFlow',
            key: const ValueKey('voice-asr-vendor'),
            style: Theme.of(dialog).textTheme.bodySmall?.copyWith(
              color: Theme.of(dialog).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('voice-asr-key'),
            controller: controller,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(labelText: l10n.voiceAsrKeyLabel, helperText: l10n.voiceAsrKeyHint),
          ),
        ],
      ),
      actions: [
        TextButton(
          key: const ValueKey('voice-asr-clear'),
          onPressed: () async {
            final r = await ref.read(voiceConfigProvider.notifier).saveAsr(remove: true);
            if (dialog.mounted) Navigator.pop(dialog, r);
          },
          child: Text(l10n.voiceServiceClear),
        ),
        FilledButton(
          key: const ValueKey('voice-asr-save'),
          onPressed: () async {
            final r = await ref.read(voiceConfigProvider.notifier).saveAsr(key: controller.text);
            if (dialog.mounted) Navigator.pop(dialog, r);
          },
          child: Text(l10n.voiceServiceSave),
        ),
      ],
    ),
  );
  if (!context.mounted || receipt == null) return;
  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
    SnackBar(content: Text('${receipt.ok ? l10n.voiceServiceSaved : l10n.voiceServiceSaveFailed} · ${receipt.message}')),
  );
}

/// TTS: provider, service URL + voice id (not secret) and an optional key.
/// Opening the dialog pre-fills the saved URL/voice when there is one, else the
/// cloud provider's defaults; the key is never read back.
Future<void> _editTts(BuildContext context, WidgetRef ref) async {
  final l10n = context.l10n;
  final saved = await ref.read(voiceConfigProvider.notifier).savedTts();
  if (!context.mounted) return;
  // Fresh install opens on cloud prins with its defaults; an existing LAN
  // setting opens on the LAN gateway so saving again does not quietly rewrite it.
  final lan = _ttsVendorDefaults[_TtsVendor.lan]!;
  final cloud = _ttsVendorDefaults[_TtsVendor.cloud]!;
  var vendor = saved.base.isEmpty || saved.base == cloud.base
      ? _TtsVendor.cloud
      : saved.base == lan.base
      ? _TtsVendor.lan
      : _TtsVendor.cloud;
  final base = TextEditingController(
    text: saved.base.isNotEmpty ? saved.base : cloud.base,
  );
  final voice = TextEditingController(
    text: saved.voice.isNotEmpty ? saved.voice : cloud.voice,
  );
  final keyCtrl = TextEditingController();
  final receipt = await showDialog<VoiceConfigReceipt?>(
    context: context,
    builder: (dialog) => StatefulBuilder(
      builder: (dialog, setState) {
        void pick(_TtsVendor next) {
          if (next == vendor) return;
          setState(() {
            vendor = next;
            final defaults = _ttsVendorDefaults[next]!;
            base.text = defaults.base;
            voice.text = defaults.voice;
          });
        }

        return AlertDialog(
          title: Text(l10n.voiceTtsService),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SegmentedButton<_TtsVendor>(
                  key: const ValueKey('voice-tts-vendor'),
                  segments: [
                    ButtonSegment(
                      value: _TtsVendor.cloud,
                      label: Text('云端', key: const ValueKey('voice-tts-vendor-cloud')),
                    ),
                    ButtonSegment(
                      value: _TtsVendor.lan,
                      label: Text('局域', key: const ValueKey('voice-tts-vendor-lan')),
                    ),
                  ],
                  selected: {vendor},
                  showSelectedIcon: false,
                  onSelectionChanged: (selection) => pick(selection.first),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('voice-tts-base'),
                  controller: base,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(labelText: l10n.voiceTtsBaseLabel, hintText: 'https://'),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('voice-tts-voice'),
                  controller: voice,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(labelText: l10n.voiceTtsVoiceLabel),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('voice-tts-key'),
                  controller: keyCtrl,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(labelText: 'TTS Key', helperText: '可留空'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              key: const ValueKey('voice-tts-clear'),
              onPressed: () async {
                final r = await ref.read(voiceConfigProvider.notifier).clearTts();
                if (dialog.mounted) Navigator.pop(dialog, r);
              },
              child: Text(l10n.voiceServiceClear),
            ),
            FilledButton(
              key: const ValueKey('voice-tts-save'),
              onPressed: () async {
                final r = await ref
                    .read(voiceConfigProvider.notifier)
                    .saveTts(base: base.text, voice: voice.text, key: keyCtrl.text);
                if (dialog.mounted) Navigator.pop(dialog, r);
              },
              child: Text(l10n.voiceServiceSave),
            ),
          ],
        );
      },
    ),
  );
  if (!context.mounted || receipt == null) return;
  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
    SnackBar(content: Text('${receipt.ok ? l10n.voiceServiceSaved : l10n.voiceServiceSaveFailed} · ${receipt.message}')),
  );
}
