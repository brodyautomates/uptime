#!/bin/zsh
# Gate G15 on a clean macOS user account. Needs an administrator password.
#   sudo zsh scripts/test-second-account.sh
# Creates a temporary standard user, copies the app out of the dmg into that user's home, launches it as that user in
# test mode, checks that it boots and that the terminal runs a command, then deletes the user again.
set -e
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; DMG="$ROOT/dist/UPTIME-0.1.0-arm64.dmg"; U=uptimegate
[[ -f "$DMG" ]] || { echo "no dmg: run npm run dist first"; exit 1; }
PASS="$(openssl rand -hex 12)"
sysadminctl -addUser $U -fullName "UPTIME gate" -password "$PASS" >/dev/null 2>&1
HOME_DIR="/Users/$U"; createhomedir -c -u $U >/dev/null 2>&1 || true
cleanup() { hdiutil detach "$MNT" -force >/dev/null 2>&1 || true; sysadminctl -deleteUser $U >/dev/null 2>&1 || true; }
trap cleanup EXIT
MNT="$(mktemp -d)"; hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null
sudo -u $U mkdir -p "$HOME_DIR/Applications"; cp -R "$MNT/UPTIME.app" "$HOME_DIR/Applications/"; chown -R $U "$HOME_DIR/Applications/UPTIME.app"
OUT="$HOME_DIR/gate.txt"
# The app writes its own result in test mode when UPTIME_SELFTEST is set: boot, racks present, terminal echo.
sudo -u $U env HOME="$HOME_DIR" UPTIME_SELFTEST="$OUT" UPTIME_PRESET=fresh "$HOME_DIR/Applications/UPTIME.app/Contents/MacOS/UPTIME" >/dev/null 2>&1 &
PID=$!; for i in {1..40}; do [[ -f "$OUT" ]] && break; sleep 1; done; kill $PID >/dev/null 2>&1 || true
if [[ -f "$OUT" ]]; then cat "$OUT"; grep -q '"pass":true' "$OUT" && echo "G15 on a second account: PASS" || { echo "G15 on a second account: FAIL"; exit 1; }
else echo "G15 on a second account: FAIL (the app wrote no result; macOS may refuse to show another user's window in your session — log in as $U and run the app once instead)"; exit 1; fi
