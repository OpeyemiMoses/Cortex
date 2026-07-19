#!/usr/bin/env sh
# scripts/install-onchainos.sh
# Run by Railway's build step (via package.json "build" script) to install
# the onchainos CLI so it's available to the A2A provider daemon at runtime.
set -e

if command -v onchainos >/dev/null 2>&1; then
  echo "[install-onchainos] already installed: $(onchainos --version)"
  exit 0
fi

echo "[install-onchainos] downloading onchainos CLI..."
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
echo "[install-onchainos] onchainos installed: $(onchainos --version)"
