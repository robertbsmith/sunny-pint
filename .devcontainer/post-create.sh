#!/bin/bash
set -e

echo "=== SunPub post-create setup ==="

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
