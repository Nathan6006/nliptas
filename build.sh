#!/bin/sh
# Wraps the artifact source (a fragment: claude.ai supplies the document shell)
# into a standalone page for static hosting. Single source of truth: signal-ledger.html
# The fragment splits at <header class="topbar">: everything above it is head
# material (title, font link, styles), everything from it down is the body.
set -e
src=signal-ledger.html
out=public/index.html
split=$(grep -n '^<header class="topbar">' "$src" | head -1 | cut -d: -f1)
[ -n "$split" ] || { echo "build: split marker not found in $src" >&2; exit 1; }
mkdir -p public
{
  cat <<'HEAD'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Plan the next day, score every 15 minutes from 6am to 6am as signal or noise, and track the ratio over time.">
<meta name="color-scheme" content="light dark">
<style>
:root{color-scheme:light dark;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif;background:#fcfcfb}
img{max-width:100%}
[hidden]{display:none!important}
</style>
HEAD
  head -n $((split - 1)) "$src"
  printf '</head>\n<body>\n'
  tail -n +"$split" "$src"
  printf '</body>\n</html>\n'
} > "$out"
echo "built $out ($(wc -c < "$out" | tr -d ' ') bytes)"
