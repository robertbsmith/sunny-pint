#!/bin/bash
set -e

echo "=== SunPub post-create setup ==="

# Install frontend deps
if [ -f package.json ]; then
  echo "Installing frontend dependencies..."
  pnpm install
fi

# Install Python build script deps
if [ -f pyproject.toml ]; then
  echo "Installing Python build tools..."
  uv sync
fi

# Copy Claude config into the persisted volume if not already there
if [ -d .claude ] && [ ! -f /root/.claude/settings.json ]; then
  echo "Initialising Claude Code config..."
  cp -n .claude/settings.json /root/.claude/settings.json 2>/dev/null || true
fi

echo "=== Setup complete ==="
