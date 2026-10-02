#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print 'Install Node.js 22.16 or newer with npm, then run this installer again.'
  read '?Press Return to close…'
  exit 1
fi
if ! node scripts/macos/build-app.mjs; then
  print 'Installation did not finish. See the message above.'
  read '?Press Return to close…'
  exit 1
fi
