#!/usr/bin/env bash
# One-shot cloud build for the voice-enabled DSH-Go APK.
#
#   bash tooling/cloud-build-apk.sh                 # full: runtime + pub + analyze + test + apk
#   bash tooling/cloud-build-apk.sh --skip-runtime  # reuse runtime/out (already built)
#   bash tooling/cloud-build-apk.sh --no-test       # skip flutter test (faster)
#
# Assumes the toolchain the previous round installed at $TOOLCHAIN (default
# /root/toolchain): jdk-17, flutter, android-sdk with cmake+ninja.
# Everything runs with `nice` and 2 Gradle workers so it never competes with a
# training job on the same box; it never touches GPUs and never restarts DSH.
set -euo pipefail

TOOLCHAIN="${TOOLCHAIN:-/root/toolchain}"
SKIP_RUNTIME=0
RUN_TEST=1
while (($#)); do
  case "$1" in
    --skip-runtime) SKIP_RUNTIME=1; shift ;;
    --no-test) RUN_TEST=0; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

export JAVA_HOME="$TOOLCHAIN/jdk-17"
export ANDROID_HOME="$TOOLCHAIN/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PUB_HOSTED_URL=https://pub.flutter-io.cn
export FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn
export PATH="$JAVA_HOME/bin:$TOOLCHAIN/flutter/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# python3 / node are not always on PATH on the build box (conda + a downloaded
# host node are). Resolve them once and export so runtime + tests see them.
if ! command -v python3 >/dev/null 2>&1; then
  for c in /root/miniconda3/bin /usr/local/bin; do
    [ -x "$c/python3" ] && export PATH="$c:$PATH" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  for c in "$ROOT/runtime/.cache/host-node"/node-v*-linux-x64/bin /usr/local/bin; do
    [ -x "$c/node" ] && export PATH="$c:$PATH" && break
  done
fi
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
command -v flutter >/dev/null || { echo "flutter not found under $TOOLCHAIN" >&2; exit 1; }

step() { printf '\n=== %s ===\n' "$*"; }

step "0/7 toolchain"
flutter --version | head -2
"$JAVA_HOME/bin/java" -version 2>&1 | head -1

# Termux dropped proot 5.1.107.98 from its index; the pin must be the current one.
grep -q 'PROOT_VERSION="5.1.107.102"' runtime/build-runtime.sh \
  || echo "warn: runtime/build-runtime.sh proot pin is not 5.1.107.102 — the Termux index may have moved again"

if ((SKIP_RUNTIME)); then
  step "1/7 runtime (skipped)"
  [ -f runtime/out/arm64-v8a/assets/runtime/manifest.json ] || { echo "no runtime/out to reuse" >&2; exit 1; }
else
  step "1/7 runtime arm64-v8a (this takes a while)"
  nice -n 15 bash runtime/build-runtime.sh arm64-v8a
fi

step "2/7 flutter pub get"
(cd app && nice -n 15 flutter pub get)

step "3/7 l10n (parts -> app_*.arb -> gen)"
(cd app && python3 tool/l10n_merge.py)

step "4/7 flutter analyze"
(cd app && nice -n 15 flutter analyze)

if ((RUN_TEST)); then
  step "5/7 tests"
  (cd app && nice -n 15 flutter test)
  # The local voice service's offline contract (41 tests, no network).
  if command -v node >/dev/null 2>&1; then
    (cd runtime/voicecall && node --test server-tests/*.test.mjs)
  else
    echo "node not found — server-tests not run"
  fi
  # Engine bridge/patch tests need a built DSH prefix (DSH_PREFIX); the runtime
  # build above produced one under runtime/.work.
  PREFIX="$ROOT/runtime/.work/arm64-v8a/dsh-prefix"
  if [ -d "$PREFIX/node_modules/@deepseek-ai" ]; then
    (cd "$ROOT" && DSH_PREFIX="$PREFIX" node --test runtime/tests/*.test.mjs) || echo "warn: engine tests failed (see above)"
  else
    echo "no dsh-prefix — engine bridge tests skipped"
  fi
else
  step "5/7 tests (skipped)"
fi

step "6/7 APK (arm64 release)"
nice -n 15 bash tooling/build-apk.sh -f arm64

step "7/7 checksums"
APK="$ROOT/app/build/app/outputs/flutter-apk/app-arm64-release.apk"
ls -la "$APK"
sha256sum "$APK" | tee "$ROOT/app/build/app/outputs/flutter-apk/app-arm64-release.apk.sha256"
echo
echo "APK: $APK"
