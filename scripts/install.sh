#!/usr/bin/env bash
#
# install.sh — build Plain Notes (UI + MCP sidecar) and install it to /Applications.
#
# Idempotent: run it the first time to install, and re-run it any time to ship a
# new build of both the UI and the bundled MCP server. The MCP server is
# registered at a stable path (/Applications/Plain Notes.app/...), so re-running
# only rebuilds, replaces, and restarts — no re-registration drift.
#
# Usage:
#   ./scripts/install.sh [--pull] [--notes-dir DIR]
#                        [--no-register] [--no-restart] [--skip-build]
#
# Flags:
#   --pull          git pull --ff-only before building (grab a pushed version)
#   --notes-dir DIR notes directory to register (default: $PLAIN_NOTES_DIR or
#                   ~/Documents/PlainNotes)
#   --no-register   don't touch Claude Desktop / Claude Code MCP config
#   --no-restart    don't quit/relaunch Claude Desktop or Plain Notes
#   --skip-build    install the existing build without rebuilding
#
set -euo pipefail

# ---- paths -----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_NAME="Plain Notes.app"
BUILT_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
INSTALLED_APP="/Applications/$APP_NAME"
MCP_BIN="$INSTALLED_APP/Contents/MacOS/plain-notes-mcp"

# ---- options ---------------------------------------------------------------
DO_PULL=0
DO_REGISTER=1
DO_RESTART=1
DO_BUILD=1
NOTES_DIR="${PLAIN_NOTES_DIR:-$HOME/Documents/PlainNotes}"

while [ $# -gt 0 ]; do
  case "$1" in
    --pull)        DO_PULL=1 ;;
    --no-register) DO_REGISTER=0 ;;
    --no-restart)  DO_RESTART=0 ;;
    --skip-build)  DO_BUILD=0 ;;
    --notes-dir)   shift; NOTES_DIR="${1:?--notes-dir needs a value}" ;;
    -h|--help)     sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---- helpers ---------------------------------------------------------------
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

proc_running() { pgrep -x "$1" >/dev/null 2>&1; }

# quit_app <app display name> <executable/process name>
# Apps are quit/launched by their display name (osascript/open) but detected by
# their executable name — e.g. "Plain Notes" runs as the process "plain-notes".
quit_app() {
  local app="$1" proc="$2" i=0
  proc_running "$proc" || return 0
  osascript -e "tell application \"$app\" to quit" >/dev/null 2>&1 || true
  while proc_running "$proc" && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  proc_running "$proc" && pkill -x "$proc" >/dev/null 2>&1 || true  # fallback if quit was blocked/ignored
}

# ---- preflight -------------------------------------------------------------
step "Checking toolchain"
missing=0
for tool in bun pnpm cargo; do
  if command -v "$tool" >/dev/null 2>&1; then
    info "$tool: $(command -v "$tool")"
  else
    printf '    \033[1;31mmissing:\033[0m %s\n' "$tool"; missing=1
  fi
done
if [ "$DO_REGISTER" -eq 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    info "claude: $(command -v claude)"
  else
    info "claude: not found — will skip Claude Code registration"
  fi
fi
[ "$missing" -eq 0 ] || die "Install the missing tool(s) above and re-run."

# ---- pull ------------------------------------------------------------------
if [ "$DO_PULL" -eq 1 ]; then
  step "Pulling latest (git pull --ff-only)"
  git -C "$REPO_ROOT" pull --ff-only
fi

# ---- build -----------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  step "Building MCP sidecar (bun compile, arm64 + x64)"
  ( cd "$REPO_ROOT/mcp-server" && bun install && bun run compile )

  step "Building Plain Notes.app (pnpm tauri build)"
  info "Skipping .dmg (--bundles app); a local install only needs the .app."
  ( cd "$REPO_ROOT" && pnpm install && pnpm tauri build --bundles app )
fi

[ -d "$BUILT_APP" ] || die "Build output not found: $BUILT_APP
Run without --skip-build, or check the tauri build output above."

# ---- install ---------------------------------------------------------------
step "Installing to /Applications"
if proc_running "plain-notes"; then
  info "Quitting running Plain Notes…"
  quit_app "Plain Notes" "plain-notes"
fi
rm -rf "$INSTALLED_APP"
ditto "$BUILT_APP" "$INSTALLED_APP"
info "Installed: $INSTALLED_APP"

if [ -x "$MCP_BIN" ]; then
  info "MCP sidecar embedded: $MCP_BIN"
else
  die "MCP sidecar missing from the bundle ($MCP_BIN).
Did 'bun run compile' produce src-tauri/bin/plain-notes-mcp-*-apple-darwin?"
fi

# ---- register MCP clients --------------------------------------------------
if [ "$DO_REGISTER" -eq 1 ]; then
  step "Registering MCP server (notes dir: $NOTES_DIR)"

  # Claude Desktop: merge into claude_desktop_config.json, preserving any other
  # servers, backing up first, never clobbering an unparseable file. Uses bun
  # (already required) so there's no extra dependency.
  CD_DIR="$HOME/Library/Application Support/Claude"
  CD_CFG="$CD_DIR/claude_desktop_config.json"
  mkdir -p "$CD_DIR"
  [ -f "$CD_CFG" ] && cp "$CD_CFG" "$CD_CFG.bak"
  if PN_CFG="$CD_CFG" PN_BIN="$MCP_BIN" PN_DIR="$NOTES_DIR" bun -e '
    const fs = require("fs");
    const cfgPath = process.env.PN_CFG;
    let root = {};
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, "utf8").trim();
      if (txt) {
        try { root = JSON.parse(txt); }
        catch (e) { console.error("invalid JSON in " + cfgPath + " — left untouched"); process.exit(3); }
      }
    }
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      console.error("config root is not a JSON object — left untouched"); process.exit(3);
    }
    if (typeof root.mcpServers !== "object" || root.mcpServers === null || Array.isArray(root.mcpServers)) {
      root.mcpServers = {};
    }
    root.mcpServers["plain-notes"] = {
      command: process.env.PN_BIN,
      args: ["--notes-dir", process.env.PN_DIR],
    };
    const tmp = cfgPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n");
    fs.renameSync(tmp, cfgPath);
  '; then
    info "Claude Desktop: registered (backup at claude_desktop_config.json.bak)"
  else
    info "Claude Desktop: SKIPPED — fix the config above and re-run, or use the app's 'Connect to Claude' button."
  fi

  # Claude Code: idempotent re-register at user scope.
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove plain-notes -s user >/dev/null 2>&1 || true
    if claude mcp add plain-notes -s user -- "$MCP_BIN" --notes-dir "$NOTES_DIR" >/dev/null 2>&1; then
      info "Claude Code: registered (user scope)"
    else
      info "Claude Code: registration failed — run manually:"
      info "  claude mcp add plain-notes -s user -- \"$MCP_BIN\" --notes-dir \"$NOTES_DIR\""
    fi
  fi
fi

# ---- restart clients -------------------------------------------------------
if [ "$DO_RESTART" -eq 1 ]; then
  step "Restarting clients"
  if proc_running "Claude"; then
    info "Claude Desktop: quitting + reopening to load the new sidecar…"
    quit_app "Claude" "Claude"
    open -a "Claude"
  else
    info "Claude Desktop: not running — loads the new sidecar on next launch."
  fi
  info "Claude Code: new 'claude' sessions use the updated server automatically;"
  info "             in an open session run /mcp to reconnect."
  info "Launching Plain Notes…"
  open -a "Plain Notes" || true
fi

step "Done"
info "App:        $INSTALLED_APP"
info "MCP binary: $MCP_BIN"
info "Notes dir:  $NOTES_DIR"
info "Toggle the window with Option+N."
