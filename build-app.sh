#!/usr/bin/env bash
set -euo pipefail

# SocketAgent App Build Script
#
# Usage:
#   ./build-app.sh                     # Build APK on remote build machine
#   ./build-app.sh --flavor play       # Build the Play APK for validation
#   ./build-app.sh --flavor play --bundle  # Build the Play Store AAB
#   ./build-app.sh --deploy            # Build, bump patch, deploy to GitHub
#   ./build-app.sh --deploy --bump minor   # Build, bump minor, deploy

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_PARENT="$(cd "$REPO_ROOT/.." && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$REPO_PARENT/socketagent-app}"
PUBSPEC="$APP_DIR/pubspec.yaml"
VERSION_FILE="$REPO_ROOT/app-version.json"
SERVER_REPO="Yllib/socketagent"
APK_PATH="$APP_DIR/build/app/outputs/flutter-apk/app-release.apk"
AAB_PATH="$APP_DIR/build/app/outputs/bundle/playRelease/app-play-release.aab"
APP_ID_OVERRIDE="${SOCKETAGENT_APPLICATION_ID:-}"
SIGN_RELEASES="${SOCKETAGENT_SIGN_RELEASES:-1}"
SIGNING_KEY="${SOCKETAGENT_GIT_SIGNING_KEY:-$HOME/.ssh/id_rsa.pub}"

FLUTTER_BIN="${FLUTTER_BIN:-/opt/flutter/bin}"
export PATH="$FLUTTER_BIN:/home/rdp/Android/Sdk/platform-tools:$PATH"

# ── Remote build config ──
REMOTE_HOST="billy@10.10.10.69"
REMOTE_DIR="C:/Users/billy/socketagent-app-build"
REMOTE_FLUTTER="C:/Users/billy/Downloads/flutter/flutter/bin/flutter.bat"
REMOTE_ANDROID_HOME="C:/Users/billy/AppData/Local/Android/Sdk"

BUMP="patch"
DEPLOY=false
FLAVOR="direct"
BUNDLE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --deploy) DEPLOY=true; shift ;;
    --flavor) FLAVOR="$2"; shift 2 ;;
    --bundle) BUNDLE=true; shift ;;
    --local) echo "Local app builds are disabled. Use the remote build machine."; exit 1 ;;
    --bump) BUMP="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; echo "Usage: $0 [--flavor direct|play] [--bundle] [--deploy] [--bump major|minor|patch]"; exit 1 ;;
  esac
done

if [[ "$FLAVOR" != "direct" && "$FLAVOR" != "play" ]]; then
  echo "Invalid flavor: $FLAVOR (use direct or play)" >&2
  exit 1
fi
if $DEPLOY && [[ "$FLAVOR" != "direct" ]]; then
  echo "GitHub deployment is only available for the direct flavor." >&2
  exit 1
fi
if $BUNDLE && [[ "$FLAVOR" != "play" ]]; then
  echo "App bundles are only supported for the Play flavor." >&2
  exit 1
fi
if $BUNDLE && $DEPLOY; then
  echo "Play app bundles cannot use the direct GitHub deployment flow." >&2
  exit 1
fi

if $BUNDLE; then
  BUILD_KIND="appbundle"
  ARTIFACT_LABEL="Play app bundle"
  ARTIFACT_PATH="$AAB_PATH"
  REMOTE_ARTIFACT_RELATIVE="build/app/outputs/bundle/playRelease/app-play-release.aab"
else
  BUILD_KIND="apk"
  ARTIFACT_LABEL="$FLAVOR APK"
  ARTIFACT_PATH="$APK_PATH"
  REMOTE_ARTIFACT_RELATIVE="build/app/outputs/flutter-apk/app-${FLAVOR}-release.apk"
fi

git_signed() {
  if [[ "$SIGN_RELEASES" == "0" || "$SIGN_RELEASES" == "false" || "$SIGN_RELEASES" == "off" ]]; then
    git "$@"
  else
    git -c gpg.format=ssh -c user.signingkey="$SIGNING_KEY" "$@"
  fi
}

git_commit_release() {
  local message="$1"
  if git diff --cached --quiet; then
    echo "No staged changes for: $message"
    return 0
  fi
  if [[ "$SIGN_RELEASES" == "0" || "$SIGN_RELEASES" == "false" || "$SIGN_RELEASES" == "off" ]]; then
    git commit -m "$message"
  else
    git_signed commit -S -m "$message"
  fi
}

git_tag_release() {
  local tag="$1"
  local message="$2"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "Tag already exists: $tag"
    return 0
  fi
  if [[ "$SIGN_RELEASES" == "0" || "$SIGN_RELEASES" == "false" || "$SIGN_RELEASES" == "off" ]]; then
    git tag -a "$tag" -m "$message"
  else
    git_signed tag -s "$tag" -m "$message"
  fi
}

if $DEPLOY && [[ ! "$SIGN_RELEASES" =~ ^(0|false|off)$ ]]; then
  [[ -f "$SIGNING_KEY" ]] || { echo "Signing key not found: $SIGNING_KEY"; exit 1; }
fi

if [[ ! -d "$APP_DIR/.git" || ! -f "$PUBSPEC" ]]; then
  echo "SocketAgent app repo not found: $APP_DIR" >&2
  echo "Set SOCKETAGENT_APP_DIR to its absolute path if it is not beside the server repo." >&2
  exit 1
fi

# ── Read current version ──
CURRENT=$(grep '^version:' "$PUBSPEC" | sed 's/version: //' | cut -d+ -f1)
BUILD=$(grep '^version:' "$PUBSPEC" | sed 's/version: //' | cut -d+ -f2)
ORIGINAL_VERSION_LINE=$(grep '^version:' "$PUBSPEC")
VERSION_BUMPED=false
APP_VERSION_COMMITTED=false

restore_version_on_failure() {
  local code=$?
  if $VERSION_BUMPED && ! $APP_VERSION_COMMITTED; then
    sed -i "s/^version: .*/$ORIGINAL_VERSION_LINE/" "$PUBSPEC"
    echo "Restored pubspec version after failed build/deploy."
  fi
  exit "$code"
}
trap restore_version_on_failure ERR

echo "Checking remote build machine ($REMOTE_HOST)..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" "echo ok" >/dev/null

if $DEPLOY; then
  # ── Bump version ──
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case $BUMP in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
    *) echo "Invalid bump: $BUMP (use major, minor, or patch)"; exit 1 ;;
  esac
  BUILD=$((BUILD + 1))
  NEW_VERSION="$MAJOR.$MINOR.$PATCH"
  echo "Bumping: $CURRENT → $NEW_VERSION+$BUILD"
  sed -i "s/^version: .*/version: $NEW_VERSION+$BUILD/" "$PUBSPEC"
  VERSION_BUMPED=true
else
  NEW_VERSION="$CURRENT"
  echo "Building $FLAVOR v$CURRENT (no version bump)"
fi

# ── Build Android artifact ──
echo "Building $ARTIFACT_LABEL on remote ($REMOTE_HOST)..."
if [[ -n "$APP_ID_OVERRIDE" ]]; then
  echo "Using Android applicationId override: $APP_ID_OVERRIDE"
fi
BUILD_START=$SECONDS

# Sync app source to remote via tar (Windows SSH doesn't have rsync)
echo "  Syncing source..."
tar cf - -C "$APP_DIR" \
  --exclude='build' \
  --exclude='.dart_tool' \
  --exclude='.gradle' \
  --exclude='.idea' \
  --exclude='*.iml' \
  --exclude='.flutter-plugins-dependencies' \
  . | ssh "$REMOTE_HOST" "powershell -Command \"if (Test-Path '$REMOTE_DIR') { Remove-Item '$REMOTE_DIR' -Recurse -Force }; New-Item -ItemType Directory -Path '$REMOTE_DIR' -Force | Out-Null; Set-Location '$REMOTE_DIR'; tar xf -\""

# Build on remote
echo "  Building on remote..."
REMOTE_APP_ID_ASSIGNMENT=""
if [[ -n "$APP_ID_OVERRIDE" ]]; then
  REMOTE_APP_ID_ASSIGNMENT="\$env:SOCKETAGENT_APPLICATION_ID='$APP_ID_OVERRIDE'; "
fi
BUILD_LOG="$(mktemp)"
trap - ERR
set +e
ssh "$REMOTE_HOST" "powershell -Command \"${REMOTE_APP_ID_ASSIGNMENT}\$env:ANDROID_HOME='$REMOTE_ANDROID_HOME'; Set-Location '$REMOTE_DIR'; \$artifact='$REMOTE_ARTIFACT_RELATIVE'; Remove-Item \$artifact -Force -ErrorAction SilentlyContinue; & '$REMOTE_FLUTTER' build '$BUILD_KIND' --release --flavor '$FLAVOR' --dart-define 'SOCKETAGENT_DISTRIBUTION=$FLAVOR' 2>&1; exit \$LASTEXITCODE\"" 2>&1 | tee "$BUILD_LOG" | while read -r line; do
  echo "  [remote] $line"
done
REMOTE_BUILD_EXIT=${PIPESTATUS[0]}
set -e
trap restore_version_on_failure ERR
if [[ $REMOTE_BUILD_EXIT -ne 0 ]]; then
  if $BUNDLE && grep -Fq "Release app bundle failed to strip debug symbols from native libraries." "$BUILD_LOG"; then
    echo "  Flutter hit its known app-bundle symbol-check failure; validating the generated bundle before accepting it."
  else
    rm -f "$BUILD_LOG"
    echo "Remote Flutter build failed with exit code $REMOTE_BUILD_EXIT." >&2
    exit "$REMOTE_BUILD_EXIT"
  fi
fi
rm -f "$BUILD_LOG"

if ! $BUNDLE; then
  # Refuse to publish a stale or mislabeled APK. Android's manifest parser runs
  # before the artifact is copied or any release commits are made.
  echo "  Verifying embedded app version..."
  REMOTE_BADGING="$(ssh "$REMOTE_HOST" "powershell -NoProfile -Command \"\$aapt = Get-ChildItem '$REMOTE_ANDROID_HOME/build-tools' -Recurse -Filter aapt.exe | Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName; if (-not \$aapt) { throw 'aapt.exe not found' }; & \$aapt dump badging '$REMOTE_DIR/$REMOTE_ARTIFACT_RELATIVE' | Select-Object -First 1\"" | tr -d '\r')"
  echo "  [remote] $REMOTE_BADGING"
  if [[ "$REMOTE_BADGING" != *"versionName='$NEW_VERSION'"* ]]; then
    echo "Embedded APK version name does not match release: expected $NEW_VERSION" >&2
    exit 1
  fi
  if [[ "$REMOTE_BADGING" != *"versionCode='$BUILD'"* ]]; then
    echo "Embedded APK version code does not match release: expected $BUILD" >&2
    exit 1
  fi
  REMOTE_PERMISSIONS="$(ssh "$REMOTE_HOST" "powershell -NoProfile -Command \"\$aapt = Get-ChildItem '$REMOTE_ANDROID_HOME/build-tools' -Recurse -Filter aapt.exe | Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName; if (-not \$aapt) { throw 'aapt.exe not found' }; & \$aapt dump permissions '$REMOTE_DIR/$REMOTE_ARTIFACT_RELATIVE'\"" | tr -d '\r')"
  if [[ "$FLAVOR" == "play" && "$REMOTE_PERMISSIONS" == *"android.permission.REQUEST_INSTALL_PACKAGES"* ]]; then
    echo "Play APK must not request package installation permission." >&2
    exit 1
  fi
  if [[ "$FLAVOR" == "play" && "$REMOTE_PERMISSIONS" != *"com.android.vending.BILLING"* ]]; then
    echo "Play APK is missing Google Play Billing permission." >&2
    exit 1
  fi
  if [[ "$FLAVOR" == "direct" && "$REMOTE_PERMISSIONS" != *"android.permission.REQUEST_INSTALL_PACKAGES"* ]]; then
    echo "Direct APK is missing package installation permission." >&2
    exit 1
  fi
  if [[ "$FLAVOR" == "direct" && "$REMOTE_PERMISSIONS" == *"com.android.vending.BILLING"* ]]; then
    echo "Direct APK must not request Google Play Billing permission." >&2
    exit 1
  fi
fi

# Copy artifact back
echo "  Copying $ARTIFACT_LABEL back..."
mkdir -p "$(dirname "$ARTIFACT_PATH")"
scp "$REMOTE_HOST:$REMOTE_DIR/$REMOTE_ARTIFACT_RELATIVE" "$ARTIFACT_PATH"

if $BUNDLE; then
  unzip -tq "$ARTIFACT_PATH" >/dev/null
  jarsigner -verify "$ARTIFACT_PATH" >/dev/null
  BUNDLE_ENTRIES_FILE="$(mktemp)"
  unzip -Z1 "$ARTIFACT_PATH" > "$BUNDLE_ENTRIES_FILE"
  for abi in arm64-v8a armeabi-v7a x86_64; do
    if ! grep -Fqx "base/lib/$abi/libapp.so" "$BUNDLE_ENTRIES_FILE"; then
      rm -f "$BUNDLE_ENTRIES_FILE"
      echo "Play app bundle is missing base/lib/$abi/libapp.so." >&2
      exit 1
    fi
    NATIVE_CHECK_FILE="$(mktemp)"
    unzip -p "$ARTIFACT_PATH" "base/lib/$abi/libapp.so" > "$NATIVE_CHECK_FILE"
    if readelf -S "$NATIVE_CHECK_FILE" | grep -Eq '\.(debug_info|symtab)'; then
      rm -f "$NATIVE_CHECK_FILE"
      echo "Play app bundle contains unstripped Dart native symbols for $abi." >&2
      exit 1
    fi
    rm -f "$NATIVE_CHECK_FILE"
  done
  rm -f "$BUNDLE_ENTRIES_FILE"
  echo "  App bundle signature, archive, ABIs, and stripped native libraries verified."
fi

ELAPSED=$((SECONDS - BUILD_START))
echo "Remote build completed in ${ELAPSED}s"
echo "Artifact: $ARTIFACT_PATH"
APK_SHA256="$(sha256sum "$ARTIFACT_PATH" | awk '{print $1}')"
APK_SIZE="$(stat -c%s "$ARTIFACT_PATH")"
APK_CERT_SHA256=""
APKSIGNER="${APKSIGNER:-}"
if [[ -z "$APKSIGNER" ]]; then
  APKSIGNER="$(find "${ANDROID_HOME:-/home/rdp/Android/Sdk}/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -1 || true)"
fi
if $BUNDLE; then
  APK_CERT_SHA256=""
elif [[ -n "$APKSIGNER" && -x "$APKSIGNER" ]]; then
  APK_CERT_SHA256="$("$APKSIGNER" verify --print-certs "$ARTIFACT_PATH" 2>/dev/null | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}' | tr -d ':\r')"
else
  # The Linux server intentionally delegates Android builds to the Windows
  # desktop, so apksigner may only exist alongside that remote Android SDK.
  APK_CERT_SHA256="$(ssh "$REMOTE_HOST" "powershell -Command \"\$apksigner = Get-ChildItem '$REMOTE_ANDROID_HOME/build-tools' -Recurse -Filter apksigner.bat | Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName; & \$apksigner verify --print-certs '$REMOTE_DIR/$REMOTE_ARTIFACT_RELATIVE'\"" 2>/dev/null | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}' | tr -d ':\r')"
fi
echo "Artifact SHA-256: $APK_SHA256"
if [[ -n "$APK_CERT_SHA256" ]]; then
  echo "Signing cert SHA-256: $APK_CERT_SHA256"
fi

if ! $DEPLOY; then
  echo ""
  echo "=== Build complete ==="
  echo "Flavor: $FLAVOR"
  echo "Artifact: $ARTIFACT_PATH"
  echo "Run with --deploy to bump version and publish to GitHub."
  exit 0
fi

# ── Commit app repo ──
cd "$APP_DIR"
git add -A
git_commit_release "Release v$NEW_VERSION"
APP_VERSION_COMMITTED=true
git push

# ── Update app-version.json and push ──
cd "$REPO_ROOT"
cat > "$VERSION_FILE" << EOF
{
  "version": "$NEW_VERSION",
  "url": "https://github.com/$SERVER_REPO/releases/download/v$NEW_VERSION/app-release.apk",
  "sha256": "$APK_SHA256",
  "size": $APK_SIZE,
  "signingCertSha256": "$APK_CERT_SHA256"
}
EOF

git add "$VERSION_FILE"
git_commit_release "Release app v$NEW_VERSION"
git_tag_release "v$NEW_VERSION" "SocketAgent v$NEW_VERSION"
git push
git push origin "v$NEW_VERSION"

# ── Create GitHub release with APK ──
echo "Creating GitHub release v$NEW_VERSION..."
gh release create "v$NEW_VERSION" "$ARTIFACT_PATH" \
  --repo "$SERVER_REPO" \
  --title "SocketAgent v$NEW_VERSION" \
  --notes "App version $NEW_VERSION" \
  --latest

echo ""
echo "=== Deploy complete ==="
echo "Version: $NEW_VERSION"
echo "Release: https://github.com/$SERVER_REPO/releases/tag/v$NEW_VERSION"
echo "Users will see the update banner on next app launch."
