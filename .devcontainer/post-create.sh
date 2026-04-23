#!/bin/bash
set -e

echo "=== SunPub post-create setup ==="

# Pin pnpm's content-addressable store to the mounted volume path. This
# has to live at the USER level (~/.npmrc) rather than the repo level,
# because the repo's .npmrc ships to every consumer including Cloudflare
# Pages' build environment — which runs as a non-root user in
# /opt/buildhome and can't write to /root/.local/share/pnpm/store.
# Without this pin, pnpm defaults to <workspace>/.pnpm-store/ inside the
# bind mount, so the sunpub_pnpm_store Docker volume caches nothing.
USER_NPMRC="${HOME:-/root}/.npmrc"
if ! grep -q "^store-dir=" "$USER_NPMRC" 2>/dev/null; then
  echo "store-dir=/root/.local/share/pnpm/store" >> "$USER_NPMRC"
  echo "Pinned pnpm store-dir in $USER_NPMRC"
fi

# Install frontend deps with --frozen-lockfile so a rebuild can never
# silently upgrade packages past the committed pnpm-lock.yaml.
if [ -f package.json ]; then
  echo "Installing frontend dependencies..."
  pnpm install --frozen-lockfile
fi

# Python manifests live under pipeline/ and scripts/ (the root has no
# pyproject.toml). Pre-sync both so the first pipeline / script run
# doesn't pause for a silent multi-GB download. `uv sync` reads the
# lockfile so it's equally reproducible.
for dir in pipeline scripts; do
  if [ -f "$dir/pyproject.toml" ]; then
    echo "Syncing $dir Python deps..."
    ( cd "$dir" && uv sync )
  fi
done

# Copy Claude config into the persisted volume if not already there
if [ -d .claude ] && [ ! -f /root/.claude/settings.json ]; then
  echo "Initialising Claude Code config..."
  cp -n .claude/settings.json /root/.claude/settings.json 2>/dev/null || true
fi

echo "=== Setup complete ==="
