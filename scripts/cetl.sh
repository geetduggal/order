#!/usr/bin/env bash
# cetl  1/desktop  2/ios  3/push  4/release  all
set -euo pipefail
cd "$(dirname "$0")/.."

R=$'\033[0m' B=$'\033[1m' D=$'\033[2m'
CY=$'\033[38;5;81m' GR=$'\033[38;5;78m' RD=$'\033[38;5;203m' YL=$'\033[38;5;221m'

title() { printf "\n${B}${CY}  ◆ %s${R}\n\n" "$*"; }
cmd()   { printf "  ${D}%s${R}\n" "$*"; "$@"; }
done_() { printf "  ${GR}✓${R} ${D}%s${R}\n" "$*"; }
fail()  { printf "  ${RD}✗ %s${R}\n" "$*" >&2; exit 1; }
ask()   { printf "  ${YL}›${R} %s " "$*"; }

elapsed() { echo "$(( $(date +%s) - $1 ))s"; }

version() { python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])"; }

bump() {
  local v="$1"; IFS='.' read -r ma mi pa <<< "$v"
  case "$2" in patch) echo "$ma.$mi.$((pa+1))" ;; minor) echo "$ma.$((mi+1)).0" ;; major) echo "$((ma+1)).0.0" ;; esac
}

set_version() {
  python3 - "$1" <<'PY'
import json, pathlib, re, sys; v = sys.argv[1]
for f in ("package.json", "src-tauri/tauri.conf.json"):
    p = pathlib.Path(f); d = json.loads(p.read_text()); d["version"] = v; p.write_text(json.dumps(d, indent=2) + "\n")
p = pathlib.Path("src-tauri/Cargo.toml")
p.write_text(re.sub(r'^(version\s*=\s*)"[^"]+"', f'\\1"{v}"', p.read_text(), count=1, flags=re.MULTILINE))
PY
}

connected_device() {
  xcrun devicectl list devices 2>/dev/null | python3 -c "
import sys, re
for ln in sys.stdin:
    if 'connected' in ln and 'Watch' not in ln:
        uid = re.search(r'([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})', ln, re.I)
        lbl = re.match(r'(\S.*?)\s{2,}', ln)
        if uid: print(uid.group(1)); print(lbl.group(1).strip() if lbl else 'device'); break
"
}

# ── steps ────────────────────────────────────────────────────────────────────

step_desktop() {
  title "desktop · build + dev"
  # Kill any running dev or production instance first
  osascript -e 'tell application "Order" to quit' 2>/dev/null || true
  sleep 0.3; pkill -f "tauri dev" 2>/dev/null || true; pkill -x "Order" 2>/dev/null || true
  # Full frontend build first: catches TS errors and bundles assets.
  cmd pnpm build
  # Hot-reload dev shell — stays running while you test.
  cmd pnpm tauri dev
}

step_ios() {
  title "ios"
  local t; t=$(date +%s)
  cmd pnpm tauri ios build
  local ipa="src-tauri/gen/apple/build/arm64/Order.ipa"
  [[ -f "$ipa" ]] || fail "Order.ipa not found after build"
  done_ "built $(elapsed $t)"

  local dev; dev=$(connected_device)
  [[ -n "$dev" ]] || fail "no connected iPhone — plug in and trust this Mac"
  local uid; uid=$(echo "$dev" | head -1)
  local lbl; lbl=$(echo "$dev" | tail -1)

  cmd xcrun devicectl device install app --device "$uid" "$ipa"
  done_ "installed on $lbl"
}

step_push() {
  local branch; branch=$(git rev-parse --abbrev-ref HEAD)
  title "push · $branch"

  local dirty; dirty=$(git status --short)
  if [[ -n "$dirty" ]]; then
    printf "%s\n\n" "$(echo "$dirty" | sed 's/^/    /')"
    ask "commit message (blank = abort):"
    read -r msg
    [[ -n "$msg" ]] || fail "aborted — nothing pushed"
    cmd git add -A
    cmd git commit -m "$msg"
    done_ "committed"
  fi

  cmd git push origin "$branch"
  done_ "pushed $branch → origin"
}

step_release() {
  title "release"
  local ver; ver=$(version); local tag="v$ver"

  if gh release view "$tag" >/dev/null 2>&1; then
    printf "  ${YL}%s already exists${R}\n\n" "$tag"
    printf "  o  overwrite    re-upload to $tag\n"
    printf "  p  patch        %s → %s\n" "$ver" "$(bump "$ver" patch)"
    printf "  m  minor        %s → %s\n" "$ver" "$(bump "$ver" minor)"
    printf "  M  major        %s → %s\n" "$ver" "$(bump "$ver" major)"
    printf "  c  custom\n"
    printf "  q  abort\n\n"
    ask "[o/p/m/M/c/q]:"; read -r ch
    case "$ch" in
      o) ;;
      p) ver=$(bump "$ver" patch); tag="v$ver"; set_version "$ver"; done_ "version → $ver" ;;
      m) ver=$(bump "$ver" minor); tag="v$ver"; set_version "$ver"; done_ "version → $ver" ;;
      M) ver=$(bump "$ver" major); tag="v$ver"; set_version "$ver"; done_ "version → $ver" ;;
      c) ask "version:"; read -r ver
         [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "must be semver"
         tag="v$ver"; set_version "$ver"; done_ "version → $ver" ;;
      *) fail "aborted" ;;
    esac
  fi

  printf "\n"
  local t; t=$(date +%s)
  cmd pnpm tauri build --target aarch64-apple-darwin --bundles app
  done_ "macOS built $(elapsed $t)"

  t=$(date +%s)
  cmd pnpm tauri ios build
  done_ "iOS built $(elapsed $t)"

  local app="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Order.app"
  local ipa="src-tauri/gen/apple/build/arm64/Order.ipa"
  local zip="/tmp/Order_${ver}_aarch64_macos.app.zip"
  cmd ditto -c -k --keepParent "$app" "$zip"

  cmd git tag -f "$tag"
  cmd git push -f origin "$tag"

  local notes="**macOS:** signed, not notarized. If macOS says damaged: \`xattr -cr ~/Downloads/Order.app\`

**iOS:** development export. Install: \`xcrun devicectl device install app --device <UDID> Order.ipa\`"

  gh release view "$tag" >/dev/null 2>&1 \
    || gh release create "$tag" --title "Order $tag" --notes "$notes"
  gh release upload "$tag" "$zip" --clobber >/dev/null
  gh release upload "$tag" "$ipa" --clobber >/dev/null

  done_ "$tag  $(gh release view "$tag" --json url --jq '.url')"
}

# ── dispatch ──────────────────────────────────────────────────────────────────
run() {
  case "$1" in
    1|desktop) step_desktop ;;
    2|ios)     step_ios ;;
    3|push)    step_push ;;
    4|release) step_release ;;
    all)       step_desktop; step_ios; step_push; step_release ;;
    *) fail "unknown step '$1'  —  valid: 1/desktop  2/ios  3/push  4/release  all" ;;
  esac
}

for arg in "${@:-1}"; do run "$arg"; done
printf "\n"
