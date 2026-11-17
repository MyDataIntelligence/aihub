#!/bin/sh
# aihub installer for macOS and Linux. Re-running it updates.
#   curl -fsSL https://raw.githubusercontent.com/MyDataIntelligence/aihub/main/install.sh | sh
#   sh install.sh [--next] [--uninstall] [--dry-run]
# Through a pipe use the environment variables AIHUB_NEXT=1, AIHUB_UNINSTALL=1, AIHUB_DRY_RUN=1, AIHUB_PACKAGE=<name>.
PACKAGE="${AIHUB_PACKAGE:-@ferronhooi/aihub}"
TAG=latest
UNINSTALL=${AIHUB_UNINSTALL:-0}
DRY=${AIHUB_DRY_RUN:-0}
[ "${AIHUB_NEXT:-0}" = 1 ] && TAG=next
for a in "$@"; do
  case "$a" in
    --next) TAG=next ;;
    --uninstall) UNINSTALL=1 ;;
    --dry-run|-n) DRY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

step() { # step <text> <command...>
  text=$1; shift
  if [ "$DRY" = 1 ]; then echo "PLAN: $text"; return 0; fi
  echo "==> $text"
  "$@"
}

if [ "$UNINSTALL" = 1 ]; then
  step "aihub skills uninstall" aihub skills uninstall
  step "npm rm -g $PACKAGE" npm rm -g "$PACKAGE"
  [ "$DRY" = 1 ] || echo "aihub is removed. Your team repositories are untouched."
  exit 0
fi

# 1. Node 18 or newer. Never installed silently.
if [ "$DRY" = 1 ]; then
  echo "PLAN: check that Node 18 or newer is installed"
else
  major=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')
  if [ -z "$major" ] || [ "$major" -lt 18 ] 2>/dev/null; then
    echo "Node 18 or newer is needed and was not found."
    echo "Install it yourself, then run this installer again:"
    echo "    brew install node        (macOS)"
    echo "    or see https://nodejs.org (Linux: your package manager or nvm)"
    echo "Nothing was installed."
    exit 1
  fi
fi

# 2. The CLI (npm uses the registry from your .npmrc, so a team feed works too).
step "npm i -g $PACKAGE@$TAG" npm i -g "$PACKAGE@$TAG" || { echo "npm install failed; check your .npmrc (registry and sign-in), or use sudo / a user prefix if it is a permissions error" >&2; exit 1; }

# 3. Skills and slash commands for opencode, Codex and Copilot.
step "aihub skills install --global --client all" aihub skills install --global --client all

# 4. Check.
if [ "$DRY" = 1 ]; then
  echo "PLAN: aihub doctor"
  exit 0
fi
echo "==> aihub doctor"
doctor=$(aihub doctor)
echo "$doctor"
echo
echo "Next steps:"
n=1
if echo "$doctor" | grep -q '^FIX *auth'; then echo "  $n. Sign in: az login   (or set AIHUB_ADO_PAT)"; n=$((n+1)); fi
echo "  $n. In your team repository run: aihub init"; n=$((n+1))
echo "  $n. Try it in your coding agent: /pr"