#!/usr/bin/env bash
#
# reinstall.sh — rebuild + reinstall Plain Notes (UI + MCP sidecar) after you
# ship a new version. This is just the idempotent installer; re-running install
# is the reinstall. Pass --pull to fast-forward to origin first.
#
#   ./scripts/reinstall.sh           # rebuild from the local checkout
#   ./scripts/reinstall.sh --pull    # git pull --ff-only first, then rebuild
#
# All install.sh flags pass through (--notes-dir, --no-register, --no-restart…).
#
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" "$@"
