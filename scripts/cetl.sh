#!/usr/bin/env bash
# CETL — Code Exec Test Loop
#
# Four deterministic steps for iterating on Order:
#
#   1 | desktop   Build macOS .app, replace /Applications/Order.app, relaunch
#   2 | ios       Build iOS .ipa, install to connected iPhone via devicectl
#   3 | push      Push current branch to origin
#   4 | release   Cut a GitHub release with binary packages
#
# Usage:
#   scripts/cetl.sh           — run step 1 (default: build + relaunch desktop)
#   scripts/cetl.sh 1 2       — run steps 1 then 2
#   scripts/cetl.sh all       — run all four steps in order
#   scripts/cetl.sh release   — step 4 by name
#
set -euo pipefail
cd "$(dirname "$0")/.."

# ── colour helpers ────────────────────────────────────────────────────────────
info() { printf '\033[0;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
hr()   { printf '\033[0;90m────────────────────────────────────────\033[0m\n'; }

# ── version helpers ───────────────────────────────────────────────────────────
current_version() {
  python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])"
}

bump() {
  local v="$1" part="$2"
  IFS='.' read -r major minor patch <<< "$v"
  case "$part" in
    patch) echo "${major}.${minor}.$((patch+1))" ;;
    minor) echo "${major}.$((minor+1)).0" ;;
    major) echo "$((major+1)).0.0" ;;
  esac
}

set_version() {
  local new="$1"
  python3 - "$new" <<'PY'
import json, pathlib, re, sys
v = sys.argv[1]

for name in ("package.json", "src-tauri/tauri.conf.json"):
    p = pathlib.Path(name)
    d = json.loads(p.read_text())
    d["version"] = v
    p.write_text(json.dumps(d, indent=2) + "\n")

p = pathlib.Path("src-tauri/Cargo.toml")
txt = p.read_text()
txt = re.sub(r'^(version\s*=\s*)"[^"]+"', f'\\1"{v}"', txt, count=1, flags=re.MULTILINE)
p.write_text(txt)
PY
  ok "Version bumped to $new in package.json, tauri.conf.json, Cargo.toml"
}

# ── step 1: desktop ───────────────────────────────────────────────────────────
step_desktop() {
  hr
  info "Step 1 — Build macOS .app and relaunch"
  pnpm tauri build --target aarch64-apple-darwin --bundles app

  local app="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Order.app"
  [[ -d "$app" ]] || die "Build succeeded but Order.app not found at $app"

  info "Quitting running Order.app …"
  osascript -e 'tell application "Order" to quit' 2>/dev/null || true
  sleep 0.4
  pkill -x "Order" 2>/dev/null || true

  info "Installing to /Applications …"
  cp -r "$app" /Applications/Order.app
  open /Applications/Order.app
  ok "Order.app relaunched from /Applications"
}

# ── step 2: ios ───────────────────────────────────────────────────────────────
step_ios() {
  hr
  info "Step 2 — Build iOS .ipa and install to connected iPhone"
  pnpm tauri ios build

  local ipa="src-tauri/gen/apple/build/arm64/Order.ipa"
  [[ -f "$ipa" ]] || die "IPA not found at $ipa"

  # Find first connected non-Watch device by UUID pattern
  local device_id device_label
  device_id=$(xcrun devicectl list devices 2>/dev/null | python3 -c "
import sys, re
for line in sys.stdin:
    if 'connected' in line and 'Watch' not in line:
        m = re.search(r'([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})', line, re.I)
        if m:
            print(m.group(1))
            break
" || true)
  [[ -n "$device_id" ]] || die "No connected iPhone/iPad found. Plug in and trust this Mac."

  device_label=$(xcrun devicectl list devices 2>/dev/null | python3 -c "
import sys, re
for line in sys.stdin:
    if 'connected' in line and 'Watch' not in line:
        # Last parenthesised token is model id; everything before UUID is label
        m = re.match(r'(\S.*?)\s{2,}\S+\.coredevice\.local', line)
        print(m.group(1).strip() if m else 'device')
        break
" || echo "device")

  info "Installing on $device_label ($device_id) …"
  xcrun devicectl device install app --device "$device_id" "$ipa"
  ok "Order.ipa installed on $device_label"
}

# ── step 3: push ──────────────────────────────────────────────────────────────
step_push() {
  hr
  info "Step 3 — Push to GitHub"
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  git push origin "$branch"
  ok "Pushed branch $branch to origin"
}

# ── step 4: release ───────────────────────────────────────────────────────────
step_release() {
  hr
  info "Step 4 — Cut GitHub release"

  local version tag
  version=$(current_version)
  tag="v$version"

  if gh release view "$tag" >/dev/null 2>&1; then
    warn "Release $tag already exists."
    echo ""
    echo "  o  Overwrite — re-upload binaries to existing $tag"
    echo "  p  Patch     — $version → $(bump "$version" patch)"
    echo "  m  Minor     — $version → $(bump "$version" minor)"
    echo "  M  Major     — $version → $(bump "$version" major)"
    echo "  c  Custom    — enter version manually"
    echo "  q  Abort"
    echo ""
    read -rp "Choice [o/p/m/M/c/q]: " choice
    case "$choice" in
      o) info "Overwriting $tag …" ;;
      p) version=$(bump "$version" patch); tag="v$version"; set_version "$version" ;;
      m) version=$(bump "$version" minor); tag="v$version"; set_version "$version" ;;
      M) version=$(bump "$version" major); tag="v$version"; set_version "$version" ;;
      c)
        read -rp "Version (without v): " version
        [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must be semver (e.g. 1.2.3)"
        tag="v$version"
        set_version "$version"
        ;;
      *) die "Aborted." ;;
    esac
  fi

  info "Building macOS .app …"
  pnpm tauri build --target aarch64-apple-darwin --bundles app

  info "Building iOS .ipa …"
  pnpm tauri ios build

  local app="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Order.app"
  local ipa="src-tauri/gen/apple/build/arm64/Order.ipa"
  local zip="/tmp/Order_${version}_aarch64_macos.app.zip"

  info "Archiving .app …"
  ditto -c -k --keepParent "$app" "$zip"

  info "Tagging $tag …"
  git tag -f "$tag"
  git push -f origin "$tag"

  local notes="Source-available release. Build instructions in the README.

**macOS:** signed but not notarized. If macOS says the app is damaged, clear the quarantine flag:
\`\`\`
xattr -cr ~/Downloads/Order.app
\`\`\`

**iOS:** development export. Install via devicectl:
\`\`\`
xcrun devicectl device install app --device <UDID> Order.ipa
\`\`\`"

  gh release view "$tag" >/dev/null 2>&1 \
    || gh release create "$tag" --title "Order $tag" --notes "$notes"

  gh release upload "$tag" "$zip" --clobber && ok "Uploaded $(basename "$zip")"
  gh release upload "$tag" "$ipa" --clobber && ok "Uploaded Order.ipa"

  local url
  url=$(gh release view "$tag" --json url --jq '.url')
  ok "Release $tag: $url"
}

# ── dispatch ──────────────────────────────────────────────────────────────────
run_step() {
  case "$1" in
    1|desktop)  step_desktop ;;
    2|ios)      step_ios ;;
    3|push)     step_push ;;
    4|release)  step_release ;;
    all)        step_desktop; step_ios; step_push; step_release ;;
    *) die "Unknown step '$1'. Valid: 1/desktop, 2/ios, 3/push, 4/release, all" ;;
  esac
}

ARGS=("${@:-1}")
for arg in "${ARGS[@]}"; do run_step "$arg"; done
