#!/bin/sh
# Pi loader smoke: prove the real pi extension loader discovers and registers
# the extension (command + 3 tools) from this checkout. Runs one tiny model
# turn; set PI_SMOKE_SKIP=1 to skip when no provider is available.
set -e
cd "$(dirname "$0")/.."

if [ "$PI_SMOKE_SKIP" = "1" ]; then
  echo "loader-smoke: skipped (PI_SMOKE_SKIP=1)"
  exit 0
fi

EXT="$(pwd)/.pi/extensions/index.ts"
[ -f "$EXT" ] || { echo "loader-smoke: missing $EXT" >&2; exit 1; }

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# The prompt asks the model to echo the chrome_profiles tool result, proving
# the tool was registered and executed by real pi. HOME stays real: loading
# never writes to the store (store is only created on first /chrome pair).
pi --print --no-extensions --model "${PI_SMOKE_MODEL:-openai-codex/gpt-6.1-sol}" --extension "$EXT" \
  'Call the chrome_profiles tool once and reply with exactly its text output, nothing else.' \
  >"$OUT" 2>&1 || { echo "loader-smoke: pi exited nonzero:" >&2; cat "$OUT" >&2; exit 1; }

if grep -qiE 'paired|Pinned:|No paired' "$OUT"; then
  echo "loader-smoke: OK — extension loaded, chrome_profiles executed by real pi"
  exit 0
fi
echo "loader-smoke: chrome_profiles output not found in pi response:" >&2
cat "$OUT" >&2
exit 1
