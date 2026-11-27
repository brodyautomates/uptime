#!/bin/zsh
# usage: scripts/shot.sh <outdir> <bookmark> [bookmark...]   (env: PRESET, TIER, W, H)
cd "$(dirname "$0")/.." || exit 1
out=$1; shift; mkdir -p "$out"
list=""; for b in "$@"; do list="$list,$b:$out/${b//@/_}.png"; done
npx electron-vite build >/dev/null 2>&1 || { npx electron-vite build 2>&1 | tail -20; exit 1; }
UPTIME_SHOTS="${list:1}" UPTIME_QUERY="${QUERY:-}" UPTIME_W=${W:-1600} UPTIME_H=${H:-900} npx electron . 2>&1 | grep -v "console-message\|^$\|deprecated" | tail -${TAIL:-12}
