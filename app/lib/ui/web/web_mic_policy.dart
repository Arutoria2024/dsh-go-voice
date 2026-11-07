// Which pages may use the microphone inside an embedded WebView.
//
// Android WebView denies getUserMedia by default; granting it for every page
// the app can open would hand the mic to whatever a link points at. The app's
// WebViews are local pages only (DSH Web on 127.0.0.1:3080 and the voice page
// on 127.0.0.1:3467), so the rule is: loopback only, and only the page's own
// origin or the voice service's. Everything else — including every non-mic
// resource (camera, MIDI, protected media) — is denied by the caller.

/// The voice call page's local service (`dshgo://open/voicecall`).
const String voiceCallOrigin = 'http://127.0.0.1:3467';

/// The URL the native call entry opens in its WebView shell.
const String voiceCallUrl = '$voiceCallOrigin/';

/// `scheme://host[:port]` for an http(s) URL, with the default port left out;
/// null for anything else (file:, data:, content:, chrome-error: …).
String? webOriginOf(Uri? url) {
  if (url == null) return null;
  final scheme = url.scheme.toLowerCase();
  if (scheme != 'http' && scheme != 'https') return null;
  final host = url.host.toLowerCase();
  if (host.isEmpty) return null;
  final port = url.hasPort ? url.port : (scheme == 'https' ? 443 : 80);
  final defaultPort = scheme == 'https' ? 443 : 80;
  return port == defaultPort ? '$scheme://$host' : '$scheme://$host:$port';
}

/// Whether [host] is this device (the only place the app's pages live).
bool isLoopbackHost(String host) {
  final h = host.toLowerCase();
  return h == '127.0.0.1' || h == 'localhost' || h == '::1' || h == '[::1]';
}

/// Whether the microphone may be offered to a page whose current URL is
/// [page], for a WebView opened at [opened].
///
/// True only for a loopback http(s) page that is the voice service or the
/// same origin as the page the WebView was opened with. A page that navigated
/// somewhere else — even to another loopback port — is not trusted.
bool webMicAllowsPage({required Uri? page, required Uri opened}) {
  final origin = webOriginOf(page);
  if (origin == null) return false;
  if (!isLoopbackHost(page!.host)) return false;
  // The voice service, by any loopback name (`127.0.0.1` / `localhost`).
  final port = page.hasPort ? page.port : (page.scheme.toLowerCase() == 'https' ? 443 : 80);
  if (port == 3467) return true;
  return origin == webOriginOf(opened);
}
