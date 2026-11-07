// Portions derived from ds-harness-remote (https://github.com/liguobao/ds-harness-remote), MIT, Copyright (c) 2026 DSH Remote contributors. See THIRD_PARTY_NOTICES.md.
// What the WebRTC transport needs from a platform WebRTC stack, plus the
// selected-path classification of upstream packages/webrtc/src/
// rtc-data-channel.ts (inspectSelectedPath) and rtc-adapter.ts.
library;

import 'dart:typed_data';

import '../util/bytes.dart';
import 'transport.dart';

/// DataChannel label of protocol v1 (`ordered: true`).
const String remoteDataChannelLabel = 'dsh';

/// One ICE server as `GET /api/v1/turn/credentials` returns it. TURN
/// credentials are short-lived and bound to one connection.
class RemoteIceServer {
  const RemoteIceServer(this.urls, {this.username, this.credential});

  final List<String> urls;
  final String? username;
  final String? credential;

  /// The `iceServers` entry of an `RTCConfiguration`.
  JsonMap toJson() => {'urls': urls, 'username': ?username, 'credential': ?credential};

  @override
  String toString() => 'RemoteIceServer(${urls.join(' ')})';
}

/// [servers] without TURN: direct candidates (host, server reflexive) only.
List<RemoteIceServer> stunOnlyIceServers(List<RemoteIceServer> servers) => [
  for (final server in servers)
    if (server.urls.where(_isStunUrl).toList() case final urls when urls.isNotEmpty) RemoteIceServer(urls),
];

bool _isStunUrl(String url) {
  final value = url.trim().toLowerCase();
  return value.startsWith('stun:') || value.startsWith('stuns:');
}

/// What a [RemotePeerConnection] reports. Calls may come from any event
/// order the platform stack produces; [onClosed] ends the connection.
class RemotePeerHandlers {
  const RemotePeerHandlers({
    required this.onIceCandidate,
    required this.onOpen,
    required this.onMessage,
    required this.onClosed,
    this.iceTransportPolicy = RemoteIceTransportPolicy.all,
  });

  /// A local ICE candidate (`{candidate, sdpMid, sdpMLineIndex}`) to trickle
  /// to the Host.
  final void Function(JsonMap candidate) onIceCandidate;

  /// The DataChannel is open.
  final void Function() onOpen;

  /// One binary DataChannel message.
  final void Function(Uint8List data) onMessage;

  /// ICE or DTLS failed, or the connection or DataChannel closed.
  final void Function(String reason) onClosed;

  /// The TURN retry must gather relay candidates only so that a recently
  /// broken direct path cannot win ICE again. Platforms pass this into their
  /// RTCConfiguration as `iceTransportPolicy`.
  final RemoteIceTransportPolicy iceTransportPolicy;
}

enum RemoteIceTransportPolicy { all, relay }

/// One WebRTC peer connection with a single ordered DataChannel, as the
/// offering side. The app implements it over flutter_webrtc; the package
/// itself stays free of Flutter plugins.
abstract interface class RemotePeerConnection {
  /// Creates the ordered DataChannel [channelLabel] and an offer, sets the
  /// offer as the local description and returns its SDP. Local candidates
  /// then trickle through [RemotePeerHandlers.onIceCandidate].
  Future<String> createOffer(String channelLabel);

  /// Sets the Host's answer as the remote description.
  Future<void> setAnswer(String sdp);

  /// Adds one of the Host's ICE candidates (after [setAnswer]).
  Future<void> addIceCandidate(JsonMap candidate);

  /// Sends one binary DataChannel message; messages keep their order.
  Future<void> send(Uint8List data);

  /// `getStats()` reports, each a map with its `type`, `id` and values.
  Future<List<JsonMap>> stats();

  /// Releases the connection. No handler fires afterwards.
  Future<void> close();
}

/// Opens a [RemotePeerConnection] using [iceServers].
typedef RemotePeerConnector =
    Future<RemotePeerConnection> Function(List<RemoteIceServer> iceServers, RemotePeerHandlers handlers);

/// The data plane of the selected candidate pair in [stats]: [RemoteTransportMode.turn]
/// when either side is a relay candidate, [RemoteTransportMode.lan] for a
/// pair on the local network, else [RemoteTransportMode.p2p]; `null` while no
/// pair is selected.
RemoteTransportMode? selectedPeerPath(List<JsonMap> stats) {
  final candidates = <String, JsonMap>{};
  final pairs = <String, JsonMap>{};
  final flagged = <JsonMap>[];
  final selectedIds = <String>[];
  for (final entry in stats) {
    final id = entry['id'];
    switch (entry['type']) {
      case 'local-candidate' || 'remote-candidate':
        if (entry['candidateType'] is String && id != null) candidates['$id'] = entry;
      case 'candidate-pair':
        if (id != null) pairs['$id'] = entry;
        if (entry['selected'] == true || entry['nominated'] == true) flagged.add(entry);
      case 'transport':
        if (entry['selectedCandidatePairId'] case final String pairId) selectedIds.add(pairId);
    }
  }
  for (final pair in selectedIds.isNotEmpty ? selectedIds.map((id) => pairs[id]).nonNulls : flagged) {
    if (pair['state'] == 'failed') continue;
    final local = candidates['${pair['localCandidateId']}'];
    final remote = candidates['${pair['remoteCandidateId']}'];
    if (local == null && remote == null) continue;
    final localType = local?['candidateType'];
    final remoteType = remote?['candidateType'];
    if (localType == 'relay' || remoteType == 'relay') return RemoteTransportMode.turn;
    final lan = _isLanPair(localType, remoteType, _scope(local), _scope(remote));
    return lan ? RemoteTransportMode.lan : RemoteTransportMode.p2p;
  }
  return null;
}

/// RTT from the selected candidate pair only, in the WebRTC stats unit
/// (seconds). Never substitute a previous or merely nominated pair.
Duration? selectedPeerRoundTripTime(List<JsonMap> stats) {
  final pairs = {
    for (final e in stats)
      if (e['type'] == 'candidate-pair') e['id']: e,
  };
  final ids = [
    for (final e in stats)
      if (e['type'] == 'transport' && e['selectedCandidatePairId'] is String) e['selectedCandidatePairId'],
  ];
  final selected = ids.isNotEmpty
      ? ids.map((id) => pairs[id]).nonNulls
      : pairs.values.where((e) => e['selected'] == true || (e['nominated'] == true && e['state'] == 'succeeded'));
  for (final pair in selected) {
    if (pair['state'] == 'failed') continue;
    final rtt = pair['currentRoundTripTime'];
    if (rtt is num && rtt.isFinite && rtt >= 0 && rtt <= 3600) {
      return Duration(microseconds: (rtt * Duration.microsecondsPerSecond).round());
    }
  }
  return null;
}

enum _Scope { loopback, linkLocal, private, cgnat, reserved, public, unknown }

_Scope _scope(JsonMap? candidate) {
  final address = asString(candidate?['address']) ?? asString(candidate?['ip']);
  if (address == null || address.isEmpty) return _Scope.unknown;
  if (address.contains(':')) {
    final value = address.toLowerCase();
    if (value == '::1') return _Scope.loopback;
    if (value.startsWith('fe80:')) return _Scope.linkLocal;
    // Tailscale's overlay range is ULA-shaped but not a physical LAN.
    if (value.startsWith('fd7a:115c:a1e0:')) return _Scope.cgnat;
    if (value.startsWith('fc') || value.startsWith('fd')) return _Scope.private;
    if (value.startsWith('ff')) return _Scope.reserved;
    return _Scope.public;
  }
  final parts = address.split('.').map(int.tryParse).toList();
  if (parts.length != 4 || parts.any((p) => p == null || p < 0 || p > 255)) return _Scope.unknown;
  final [a!, b!, _, _] = parts;
  if (a == 0 || a >= 240) return _Scope.reserved;
  if (a == 127) return _Scope.loopback;
  if (a == 169 && b == 254) return _Scope.linkLocal;
  if (a == 100 && b >= 64 && b <= 127) return _Scope.cgnat;
  if (a >= 224) return _Scope.reserved;
  if (a == 10 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31)) return _Scope.private;
  return _Scope.public;
}

bool _isLocal(_Scope scope) => scope == _Scope.private || scope == _Scope.linkLocal || scope == _Scope.loopback;

bool _isLanPair(Object? localType, Object? remoteType, _Scope local, _Scope remote) {
  bool explicitlyRemote(_Scope s) => s == _Scope.public || s == _Scope.cgnat || s == _Scope.reserved;
  if (localType == 'host' && remoteType == 'host') return !explicitlyRemote(local) && !explicitlyRemote(remote);
  const direct = {'host', 'prflx'};
  if (!direct.contains(localType) || !direct.contains(remoteType)) return false;
  if (_isLocal(local) && _isLocal(remote)) return true;
  // libwebrtc reports an mDNS-hidden LAN peer as prflx without an address.
  return (localType == 'host' && _isLocal(local) && remoteType == 'prflx' && remote == _Scope.unknown) ||
      (remoteType == 'host' && _isLocal(remote) && localType == 'prflx' && local == _Scope.unknown);
}
