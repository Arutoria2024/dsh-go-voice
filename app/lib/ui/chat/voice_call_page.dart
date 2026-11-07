// The realtime voice call: a native overlay drawn by Flutter, with the local
// voice engine (127.0.0.1:3467) kept rendering *behind* it, transparent.
//
// The engine still owns the microphone, VAD, ASR, the DSH-session turn and TTS
// playback — none of that is reimplemented here. The page is only a brainstem
// now: an injected shim reads the engine's own state (`body.dataset.state`, the
// `--voice-level` amplitude, `#liveCaption`) and reports
// `{phase, level, caption, raw}` through the `DshVoiceState` channel. Flutter
// drives the mascot, the caption and the status from those real values, so the
// breathing is real audio amplitude, not a canned animation.
//
// Same route, no pushed page: [VoiceCallOverlay] is placed in the chat screen's
// Stack; the chat below it scales down and blurs while the call is open.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../../l10n/l10n.dart';
import '../../state/attachments.dart';
import '../../state/chat_error_text.dart';
import '../../state/chat_state.dart';
import '../../state/voice_config_state.dart';
import '../theme/app_icons.dart';
import '../web/web_mic_policy.dart';

const _callBg = Color(0xFF08080B);
const _pillBg = Color(0xFF17181D);
const _ink = Color(0xFFE9EEFC);
const _muted = Color(0xFF9AA3B8);
const _glowBlue = Color(0xFF5A8CFF);

/// A standalone route for the feature catalog; the chat screen embeds
/// [VoiceCallOverlay] directly instead (same look, no page push).
class VoiceCallPage extends StatelessWidget {
  const VoiceCallPage({super.key, required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _callBg,
      body: VoiceCallOverlay(sessionId: sessionId, onClosed: () => Navigator.of(context).maybePop()),
    );
  }
}

/// The full-screen voice layer. Place it in a Stack over the chat.
class VoiceCallOverlay extends ConsumerStatefulWidget {
  const VoiceCallOverlay({super.key, required this.sessionId, required this.onClosed});

  final String sessionId;

  /// Called after the exit animation finished (the host removes the overlay).
  final VoidCallback onClosed;

  @override
  ConsumerState<VoiceCallOverlay> createState() => VoiceCallOverlayState();
}

class VoiceCallOverlayState extends ConsumerState<VoiceCallOverlay> with TickerProviderStateMixin {
  late final WebViewController _controller;
  late final AnimationController _entry;
  late final Ticker _ticker;

  bool _ready = false;
  bool _closing = false;

  /// Assistant text already forwarded to the page (deltas only).
  String _sent = '';
  String? _watchedRow;
  ProviderSubscription<ChatState>? _chatSub;

  // Engine → native state.
  String _phase = 'listening';
  String _raw = '';
  String _detail = '';
  int? _turnStartIndex;
  double _ampTarget = 0;
  double _amp = 0;
  String _captionTarget = '';
  int _captionShown = 0;
  double _captionAcc = 0;

  // Frame clock (seconds since open) for the float/sway.
  Duration _prev = Duration.zero;
  double _clock = 0;
  final ValueNotifier<int> _frame = ValueNotifier<int>(0);

  final TextEditingController _text = TextEditingController();
  final FocusNode _focus = FocusNode();

  /// One system picker at a time from the `+`.
  bool _picking = false;

  @override
  void initState() {
    super.initState();
    _entry = AnimationController(vsync: this, duration: const Duration(milliseconds: 720));
    _entry.addStatusListener((status) {
      if (status == AnimationStatus.dismissed && _closing && mounted) widget.onClosed();
    });
    _watchChat();
    // 私用测试包：首次进入语音时再尝试一次预置 ASR/TTS（幂等，已配置不动）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(ref.read(voiceConfigProvider.notifier).ensurePresets());
    });
    final controller = _controller = WebViewController();
    unawaited(_setUp(controller));
    _ticker = createTicker(_onTick)..start();
    _entry.forward();
  }

  @override
  void dispose() {
    _chatSub?.close();
    _ticker.dispose();
    _entry.dispose();
    _frame.dispose();
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Chat plumbing: the same session as typing, streamed back for TTS.

  void _watchChat() {
    _chatSub = ref.listenManual<ChatState>(chatProvider(widget.sessionId), (previous, next) {
      if (_turnStartIndex != null) _forwardAssistant(next);
    });
  }

  void _forwardAssistant(ChatState state) {
    if (!_ready) return;
    final start = _turnStartIndex;
    if (start == null) return;
    if (start >= state.items.length) return;
    AssistantChatItem? live;
    for (final item in state.items.skip(start)) {
      if (item is AssistantChatItem) {
        if (item.streaming) {
          live = item;
          break;
        }
        live = item;
      }
    }
    if (live == null) return;
    final row = live.rowKey ?? live.id;
    if (_watchedRow != row) {
      _watchedRow = row;
      _sent = '';
    }
    final text = live.text;
    if (text.length > _sent.length) {
      final delta = text.substring(_sent.length);
      _sent = text;
      _push('__dshVoiceSink && __dshVoiceSink.onDelta', delta);
    }
    if (!live.streaming && !state.running) {
      _push('__dshVoiceSink && __dshVoiceSink.onDone', null);
    }
  }

  void _push(String expression, String? text) {
    final arg = text == null ? '' : jsonEncode(text);
    unawaited(_controller.runJavaScript('$expression($arg)').catchError((_) {}));
  }

  Future<void> _onBridgeMessage(String message) async {
    Map<String, dynamic> data;
    try {
      data = (jsonDecode(message) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    switch (data['type']) {
      case 'ask':
        final text = (data['text'] as String?)?.trim() ?? '';
        if (text.isEmpty) return;
        _turnStartIndex = ref.read(chatProvider(widget.sessionId)).items.length;
        final ok = await _sendToSession(text, announce: false);
        if (!ok) _push('__dshVoiceSink && __dshVoiceSink.onError', _sendFailed);
        return;
      case 'stop':
        unawaited(ref.read(chatProvider(widget.sessionId).notifier).cancel());
        return;
      default:
        return;
    }
  }

  String get _sendFailed => '没有发送成功，请重试';

  String _sendFailureText() {
    final error = ref.read(chatProvider(widget.sessionId)).error;
    if (error != null && error.isNotEmpty) return error;
    return _sendFailed;
  }

  /// Sends text/files into the open conversation exactly the way the composer
  /// does: wait for the follow snapshot (`controlReady`) first, then `send`
  /// with [SendMode.queue] so a running turn never becomes a steer the Host
  /// may reject; if the first attempt loses its operation to a re-sync, retry
  /// once. A failure surfaces the real chat error, not just a generic line.
  Future<bool> _sendToSession(
    String text, {
    List<DraftAttachment> attachments = const [],
    bool announce = true,
  }) async {
    final provider = chatProvider(widget.sessionId);
    final notifier = ref.read(provider.notifier);
    if (!ref.read(provider).controlReady) {
      final ready = await notifier.waitForSync();
      if (!ready || !mounted) {
        if (announce && mounted) _toast(_sendFailureText());
        return false;
      }
    }
    var ok = await notifier.send(text, attachments: attachments, mode: SendMode.queue);
    if (!ok) {
      final ready = ref.read(provider).controlReady || await notifier.waitForSync();
      if (ready) {
        ok = await notifier.send(text, attachments: attachments, mode: SendMode.queue);
      }
    }
    if (!ok && announce && mounted) _toast(_sendFailureText());
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Engine state in.

  void _onState(String message) {
    Map<String, dynamic> data;
    try {
      data = (jsonDecode(message) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final phase = data['phase'] as String? ?? 'idle';
    final level = (data['level'] as num?)?.toDouble() ?? 0;
    final caption = data['caption'] as String? ?? '';
    final raw = data['raw'] as String? ?? '';
    final detail = (data['detail'] as String? ?? '').trim();
    _phase = phase;
    _raw = raw;
    _detail = detail;
    _ampTarget = level.clamp(0.0, 1.0);
    if (phase == 'error' || raw == 'error') {
      debugPrint('voice call: engine error (phase=$phase raw=$raw): ${detail.isEmpty ? '(no detail)' : detail}');
    }
    if (caption != _captionTarget) {
      _captionTarget = caption;
      _captionShown = 0;
      _captionAcc = 0;
    }
  }

  void _onTick(Duration elapsed) {
    final dt = (elapsed - _prev).inMicroseconds / 1e6;
    _prev = elapsed;
    if (dt <= 0) return;
    if (dt > 0.1) return; // a stall must not jump the animation
    _clock += dt;
    final k = 1 - math.exp(-dt * (_ampTarget > _amp ? 11 : 7));
    _amp += (_ampTarget - _amp) * k;
    if (_captionShown < _captionTarget.length) {
      _captionAcc += dt * (16 + 30 * _amp);
      final want = _captionAcc.floor();
      if (want > _captionShown) {
        _captionShown = want > _captionTarget.length ? _captionTarget.length : want;
      }
    }
    _frame.value++;
  }

  // ---------------------------------------------------------------------------
  // WebView: the unchanged engine, kept invisible but rendering.

  Future<void> _setUp(WebViewController controller) async {
    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      // TTS + sound effects start without a WebView tap (the tap happened in
      // Flutter); the mic itself is still granted per request below.
      await platform.setMediaPlaybackRequiresUserGesture(false).catchError((_) {});
      await platform.setBackgroundColor(const Color(0x00000000)).catchError((_) {});
      await platform.setOnPlatformPermissionRequest((request) async {
        final types = request.types;
        if (types.length != 1 || !types.contains(WebViewPermissionResourceType.microphone)) {
          await request.deny();
          return;
        }
        String? state;
        try {
          state = await const MethodChannel('dsh/voice').invokeMethod<String>('requestPermission');
        } catch (_) {
          state = null;
        }
        if (state == 'granted') {
          await request.grant();
        } else {
          await request.deny();
        }
      });
    }
    await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await controller.addJavaScriptChannel(
      'DshVoiceBridge',
      onMessageReceived: (m) => unawaited(_onBridgeMessage(m.message)),
    );
    await controller.addJavaScriptChannel(
      'DshVoiceState',
      onMessageReceived: (m) => _onState(m.message),
    );
    await controller.setNavigationDelegate(
      NavigationDelegate(
        onPageFinished: (_) async {
          await controller.runJavaScript('''
            if (!window.DshVoiceAsk) {
              window.DshVoiceAsk = function (text) {
                DshVoiceBridge.postMessage(JSON.stringify({ type: 'ask', text: String(text) }));
              };
            }
            if (!window.__dshVoiceSink) { window.__dshVoiceSink = null; }
          ''').catchError((_) {});
          await _injectHost(controller);
          _ready = true;
          _sfx('start', 0.7);
          _turnStartIndex = null;
        },
      ),
    );
    await controller.loadRequest(Uri.parse(voiceCallUrl));
  }

  /// Installs the reporting shim, the manual-text hook, the sound effects
  /// (the three real wavs from app assets, played through the page's audio
  /// stack) and auto-starts the call — all without touching the engine files.
  Future<void> _injectHost(WebViewController controller) async {
    final sfx = <String, String>{};
    for (final name in const ['start', 'stop', 'tick']) {
      try {
        final data = await rootBundle.load('assets/voice/$name.wav');
        sfx[name] = base64Encode(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      } catch (_) {
        // Missing sound is silent, not fatal.
      }
    }
    final js = '''
(function(){
  if(window.__dshHosted) return; window.__dshHosted=true;
  var sfx=${jsonEncode(sfx)};
  window.__dshSfx=function(name,vol){
    try{
      var b64=sfx[name]; if(!b64) return;
      var a=new Audio('data:audio/wav;base64,'+b64);
      a.volume=(vol==null?0.6:vol);
      var p=a.play(); if(p&&p.catch) p.catch(function(){});
    }catch(e){}
  };
  window.__dshSay=function(text){
    var box=document.getElementById('txt'); if(!box) return;
    box.value=String(text==null?'':text);
    box.dispatchEvent(new Event('input',{bubbles:true}));
    var s=document.getElementById('send'); if(s) s.click();
  };
  window.__dshHangup=function(){
    var h=document.getElementById('hangup'); if(h){h.disabled=false;h.click();}
  };
  window.__dshListen=function(){
    var state=document.body.dataset.state||'';
    if(state==='speaking'){var st=document.getElementById('stage'); if(st) st.click(); return;}
    if(state==='muted'||state==='ended'||state==='idle'||state==='error'){
      var t=document.getElementById('talk'); if(t) t.click();
    }
  };
  window.__dshStart=function(){
    var t=document.getElementById('talk'); if(t&&t.disabled===false) t.click();
  };
  var last='';
  setInterval(function(){
    var st=document.body.dataset.state||'idle';
    var lv=parseFloat(getComputedStyle(document.body).getPropertyValue('--voice-level'))||0;
    var capEl=document.getElementById('liveCaption');
    var cap=capEl?capEl.textContent:'';
    var statusEl=document.getElementById('status');
    var detail=statusEl?statusEl.textContent:'';
    var phase;
    if(st==='listening') phase='listening';
    else if(st==='speaking') phase='speaking';
    else if(st==='generating'||st==='buffering'||st==='recognizing'||st==='connecting') phase='thinking';
    else if(st==='error') phase='error';
    else phase='idle';
    var msg=JSON.stringify({phase:phase,level:Math.max(0,Math.min(1,lv)),caption:cap,raw:st,detail:detail});
    if(msg!==last){last=msg;try{DshVoiceState.postMessage(msg);}catch(e){}}
  },60);
  setTimeout(function(){try{window.__dshStart();}catch(e){}},350);
})();
''';
    await controller.runJavaScript(js).catchError((_) {});
  }

  /// Tap the mascot to resume a finished/idle call without hunting for a
  /// hidden control. The page owns the actual talk button; this forwards to it.
  void _resumeListening() {
    if (!_ready) return;
    _sfx('tick', 0.5);
    unawaited(_controller
        .runJavaScript('window.__dshListen && window.__dshListen()')
        .catchError((_) {}));
  }

  void _sfx(String name, double volume) {
    if (!_ready) return;
    unawaited(_controller.runJavaScript('window.__dshSfx && window.__dshSfx(${jsonEncode(name)}, $volume)').catchError((_) {}));
  }

  // ---------------------------------------------------------------------------
  // Actions.

  Future<void> _sendTyped() async {
    final text = _text.text.trim();
    if (text.isEmpty) return;
    _focus.unfocus();
    _sfx('tick', 0.5);
    // Send natively: the page's sendText() would drop the message whenever the
    // invisible WebView is not initialized/hidden. Only clear the draft if the
    // Host accepted it; otherwise keep the text so the user can retry.
    _turnStartIndex = ref.read(chatProvider(widget.sessionId)).items.length;
    final ok = await _sendToSession(text, announce: false);
    if (!mounted) return;
    if (ok) {
      if (_text.text.trim() == text) _text.clear();
    } else {
      _toast(_sendFailureText());
    }
  }

  /// The `+`: the same system picker and the same byte/limit checks the
  /// composer's ＋ uses ([attachmentPickerProvider] → `pickFiles`). The picked
  /// files then go into the current session through the same
  /// `ChatController.send(..., attachments:)` a typed message with attachments
  /// uses, which stages them for the Host itself.
  Future<void> _attachFile() async {
    if (_picking) return;
    _picking = true;
    try {
      _sfx('tick', 0.4);
      final picker = ref.read(attachmentPickerProvider);
      final PickedAttachments picked;
      try {
        picked = await picker.pickFiles(limit: maxAttachments, heldBytes: 0);
      } on PlatformException catch (e) {
        if (!mounted) return;
        _toast(
          e.code.contains('denied') || e.code.contains('permission')
              ? appL10n.chatAttachmentPermission
              : chatErrorText(e, action: appL10n.chatOpenAttachmentFailed),
        );
        return;
      } catch (e) {
        if (!mounted) return;
        _toast(chatErrorText(e, action: appL10n.chatReadFailed));
        return;
      }
      if (!mounted) return;
      // The picker already applied the per-file and per-message budgets.
      var problem = picked.problem;
      final ok = <DraftAttachment>[];
      var held = 0;
      for (final a in picked.attachments) {
        final p = attachmentProblem(a) ?? attachmentBudgetProblem(held, a);
        if (p != null) {
          problem ??= p;
        } else if (ok.length < maxAttachments) {
          ok.add(a);
          held += a.size;
        } else {
          problem ??= appL10n.chatAttachmentLimit(maxAttachments);
        }
      }
      if (ok.isEmpty) {
        _toast(problem ?? appL10n.chatReadFailed);
        return;
      }
      final typed = _text.text.trim();
      final sent = await _sendToSession(typed, attachments: ok);
      if (!mounted) return;
      if (!sent) return;
      if (typed.isNotEmpty) _text.clear();
      if (problem != null) _toast(problem);
    } finally {
      _picking = false;
    }
  }

  void _toast(String message) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));
  }

  /// The host's hang-up key asks the overlay to close gracefully.
  Future<void> requestClose() async {
    if (_closing) return;
    _closing = true;
    _focus.unfocus();
    _sfx('stop', 0.7);
    await _controller.runJavaScript('window.__dshHangup && window.__dshHangup()').catchError((_) {});
    await _entry.reverse();
    // onClosed fires from the status listener.
  }

  // ---------------------------------------------------------------------------
  // Build.

  String get _statusText {
    switch (_phase) {
      case 'speaking':
        return '正在说话…';
      case 'thinking':
        return '处理中…';
      case 'listening':
        return '正在聆听…';
      case 'error':
        return _detail.isNotEmpty ? _detail : '连接遇到问题';
      default:
        return _raw == 'error' ? (_detail.isNotEmpty ? _detail : '连接遇到问题') : '轻触头像继续';
    }
  }

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    return Material(
      color: Colors.transparent,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // The engine: invisible, still laid out and rendered (never
          // display:none) so getUserMedia and audio playback keep working.
          Positioned.fill(
            child: IgnorePointer(
              child: Opacity(opacity: 0.01, child: WebViewWidget(controller: _controller)),
            ),
          ),
          // The native layer.
          Positioned.fill(
            child: DecoratedBox(
              decoration: const BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment(0, -0.35),
                  radius: 0.95,
                  colors: [Color(0xFF101018), _callBg],
                  stops: [0, 0.62],
                ),
              ),
              child: Column(
                children: [
                  SizedBox(height: top + 22),
                  Text(
                    '语音对话',
                    style: TextStyle(
                      color: _muted.withValues(alpha: 0.85),
                      fontSize: 13,
                      letterSpacing: 3,
                    ),
                  ),
                  Expanded(child: _stage(context)),
                  _caption(context),
                  const SizedBox(height: 6),
                  AnimatedBuilder(
                    animation: _frame,
                    builder: (context, _) => Text(_statusText, style: const TextStyle(color: _muted, fontSize: 14)),
                  ),
                  const SizedBox(height: 10),
                  _bottomBar(context),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stage(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _resumeListening,
      child: LayoutBuilder(
      builder: (context, constraints) {
        final side = math.min(constraints.maxWidth * 0.74, constraints.maxHeight * 0.9);
        final glow = side * 1.2;
        return AnimatedBuilder(
          animation: Listenable.merge([_entry, _frame]),
          builder: (context, _) {
            final e = _entry.value.clamp(0.0, 1.0);
            final overshoot = Curves.easeOutBack.transform(e);
            final amp = _amp;
            final floaty = math.sin(_clock * (2 * math.pi / 3.6)) * 4 * e;
            final rot = math.sin(_clock * (2 * math.pi / 5.4)) * 2.0 * e;
            final inv = 1 - e;
            final dx = size.width * 0.34 * inv;
            final dy = size.height * 0.34 * inv;
            final scale = (0.10 + 0.90 * overshoot) * (1 + amp * 0.12);
            return Stack(
              alignment: Alignment.center,
              children: [
                Transform.scale(
                  scale: (0.55 + 0.90 * e) * (1 + amp * 0.35),
                  child: Opacity(
                    opacity: ((0.10 + 0.55 * amp) * e).clamp(0.0, 1.0).toDouble(),
                    child: Container(
                      width: glow,
                      height: glow,
                      decoration: const BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [Color(0x995A8CFF), Color(0x005A8CFF)],
                          stops: [0, 0.68],
                        ),
                      ),
                    ),
                  ),
                ),
                Transform.translate(
                  offset: Offset(dx, dy + floaty),
                  child: Transform.rotate(
                    angle: rot * math.pi / 180,
                    child: Transform.scale(
                      scale: scale,
                      child: Opacity(
                        opacity: (e * 1.25).clamp(0.0, 1.0).toDouble(),
                        child: RepaintBoundary(
                          child: Image.asset(
                            'assets/voice/mascot.webp',
                            width: side,
                            height: side,
                            fit: BoxFit.contain,
                            filterQuality: FilterQuality.medium,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        );
      },
    ),
    );
  }

  Widget _caption(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 26),
      child: SizedBox(
        height: 76,
        child: AnimatedBuilder(
          animation: _frame,
          builder: (context, _) {
            final shown = _captionTarget.length <= _captionShown
                ? _captionTarget
                : _captionTarget.substring(0, _captionShown);
            return Align(
              alignment: Alignment.topCenter,
              child: Text(
                shown,
                textAlign: TextAlign.center,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: _ink, fontSize: 17, height: 1.55),
              ),
            );
          },
        ),
      ),
    );
  }

  /// `[+] [胶囊] [✕]`: one row, every gap the same, all vertically centred.
  ///
  /// The bar sits on its own opaque strip that reaches the very bottom edge
  /// (system safe area included), so nothing from the chat page's composer can
  /// show through behind it. The bar itself has no border or nested rounded
  /// frame — only the capsule, the two round keys and this flat backing.
  Widget _bottomBar(BuildContext context) {
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    return AnimatedBuilder(
      animation: _entry,
      builder: (context, child) {
        final t = Curves.easeOutCubic.transform(((_entry.value - 0.30) / 0.70).clamp(0.0, 1.0));
        return Opacity(
          opacity: t,
          child: Transform.translate(offset: Offset(0, 26 * (1 - t)), child: child),
        );
      },
      child: ColoredBox(
        color: _callBg,
        child: AnimatedPadding(
          duration: const Duration(milliseconds: 180),
          padding: EdgeInsets.fromLTRB(14, 0, 14, 16 + bottomInset),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              _iconButton(AppIcons.add, '添加文件', () => unawaited(_attachFile())),
              const SizedBox(width: 10),
              Expanded(child: _inputPill()),
              const SizedBox(width: 10),
              _closeButton(),
            ],
          ),
        ),
      ),
    );
  }

  /// The typing line: a full capsule (its height unchanged at 52).
  Widget _inputPill() {
    return Container(
      height: 56,
      decoration: BoxDecoration(
        color: _pillBg,
        borderRadius: BorderRadius.circular(28),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18),
        child: Center(
          child: TextField(
            controller: _text,
            focusNode: _focus,
            onSubmitted: (_) { unawaited(_sendTyped()); },
            textInputAction: TextInputAction.send,
            style: const TextStyle(color: _ink, fontSize: 16),
            cursorColor: _glowBlue,
            decoration: const InputDecoration(
              isCollapsed: true,
              filled: false,
              fillColor: Colors.transparent,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              errorBorder: InputBorder.none,
              focusedErrorBorder: InputBorder.none,
              contentPadding: EdgeInsets.zero,
              hintText: '询问 DeepSeek',
              hintStyle: TextStyle(color: Color(0xFF6B7280), fontSize: 16),
            ),
          ),
        ),
      ),
    );
  }

  Widget _iconButton(IconData icon, String label, VoidCallback onTap) {
    return Semantics(
      button: true,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: 40,
          height: 40,
          decoration: const BoxDecoration(color: _pillBg, shape: BoxShape.circle),
          child: Icon(icon, size: 20, color: const Color(0xFFCFD6E6)),
        ),
      ),
    );
  }

  Widget _closeButton() {
    return Semantics(
      button: true,
      label: '关闭',
      child: GestureDetector(
        onTap: () => unawaited(requestClose()),
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: 52,
          height: 52,
          decoration: const BoxDecoration(color: Color(0xFFF4F5F8), shape: BoxShape.circle),
          child: const Icon(AppIcons.close, size: 24, color: Color(0xFF111111)),
        ),
      ),
    );
  }
}
