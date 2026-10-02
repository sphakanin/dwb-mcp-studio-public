#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'This installer is for Ubuntu/Linux. See README.md for Windows and macOS.' >&2
  exit 1
fi
for dependency in node npm curl unzip; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Missing %s. Install Node.js 22.16+ with npm, curl and unzip, then retry.\n' "$dependency" >&2
    exit 1
  fi
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 16)) { console.error("Node.js 22.16 or newer is required."); process.exit(1); }'
installation_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec node "$installation_directory/scripts/linux/cli.mjs" setup "$@"
