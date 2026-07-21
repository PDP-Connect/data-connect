#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# fresh-start.sh — Reset DataConnect to a clean first-run state.
# Usage: ./scripts/fresh-start.sh          (reset data only)
#        ./scripts/fresh-start.sh --uninstall  (remove app + all data)
#
# Clears all user data, credentials, browser sessions, and personal server
# state so you can test the app as a brand-new user.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

UNINSTALL=false
if [[ "${1:-}" == "--uninstall" ]]; then
  UNINSTALL=true
  shift
fi

echo ""
if $UNINSTALL; then
  echo -e "${YELLOW}DataConnect Uninstall${NC}"
  echo "This will remove the app and all local data."
else
  echo -e "${YELLOW}DataConnect Fresh Start${NC}"
  echo "This will delete all local user data, credentials, and browser sessions."
fi
echo ""

# Kill running app
if pgrep -x "DataConnect" > /dev/null 2>&1; then
  echo -e "  ${YELLOW}Stopping DataConnect...${NC}"
  killall "DataConnect" 2>/dev/null || true
  sleep 1
fi

# Data paths to clear
DIRS=(
  # Personal server (DB, keys, config, data, tunnel, frpc binary)
  "$HOME/data-connect/personal-server"
  # Exported connector data + Tauri app support
  "$HOME/Library/Application Support/dev.dataconnect"
  # App logs
  "$HOME/Library/Logs/dev.dataconnect"
  # WebKit webview storage (localStorage, IndexedDB, cookies)
  "$HOME/Library/WebKit/dev.dataconnect"
  # Tauri cache
  "$HOME/Library/Caches/dev.dataconnect"
)

# App paths (only for --uninstall)
APP_PATHS=(
  "/Applications/DataConnect.app"
)

# Show what will be deleted
echo "The following paths will be removed:"
echo ""
found_any=false
for path in "${DIRS[@]}"; do
  if [ -e "$path" ]; then
    size=$(du -sh "$path" 2>/dev/null | cut -f1 || echo "?")
    echo -e "  ${RED}✕${NC} $path (${size})"
    found_any=true
  fi
done

if $UNINSTALL; then
  for path in "${APP_PATHS[@]}"; do
    if [ -e "$path" ]; then
      size=$(du -sh "$path" 2>/dev/null | cut -f1 || echo "?")
      echo -e "  ${RED}✕${NC} $path (${size})"
      found_any=true
    fi
  done
fi
echo ""

if [ "$found_any" = false ]; then
  echo -e "${GREEN}Already clean — nothing to remove.${NC}"
  exit 0
fi

# Confirm unless --yes flag is passed
if [[ "${1:-}" != "--yes" && "${1:-}" != "-y" ]]; then
  echo -n "Proceed? [y/N] "
  read -r answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo ""

for path in "${DIRS[@]}"; do
  if [ -e "$path" ]; then
    rm -rf "$path"
    echo -e "  ${RED}removed${NC} $path"
  fi
done

if $UNINSTALL; then
  for path in "${APP_PATHS[@]}"; do
    if [ -e "$path" ]; then
      rm -rf "$path"
      echo -e "  ${RED}removed${NC} $path"
    fi
  done
fi

echo ""
if $UNINSTALL; then
  echo -e "${GREEN}Done! DataConnect has been uninstalled.${NC}"
else
  echo -e "${GREEN}Done! DataConnect will start fresh on next launch.${NC}"
fi
