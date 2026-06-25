#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$SCRIPT_DIR/../packaging/arch/tokentracker-linux"

cd "$PKG_DIR"
makepkg -si
