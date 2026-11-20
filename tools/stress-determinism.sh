#!/bin/bash
# The load stress behind coverage.md's 8'b review (determinism-1). Run it before any Node bump.
#   tools/stress-determinism.sh [COPIES] [PROCS] [old]
# Copies the tree to a temp dir with its own @montecrit links (its relative workspace links resolve inside
# the copy), then runs PROCS parallel vitest processes of the "same replay key" property at 400 runs,
# COPIES-independent rounds of each. `old` restores the `|| undefined` form the note describes first:
# on v26.9.0 that fails in some processes (fights hash `np:0`). STRESS_V8_FLAGS=--no-maglev runs the
# workers under those V8 flags (NODE_OPTIONS refuses them): the old text's failures go away.
# Also runs tools/stress-cold-warm.ts in PROCS processes. Prints the failures; exit 1 on any.
# Every process runs with its own MONTECRIT_HOME=$(mktemp -d). Scratch is under $TMPDIR, deleted at the end.
set -uo pipefail
ROUNDS=${1:-1}; PROCS=${2:-16}; MODE=${3:-final}
R=$(cd "$(dirname "$0")/.." && pwd)
C=$(mktemp -d)
trap 'rm -rf "$C"' EXIT
rsync -a --exclude .git --exclude .claude "$R/" "$C/"
cd "$C"
if [ "$MODE" = old ]; then
  python3 -I - <<'PY'
import re
p='packages/engine/src/sim/state.ts'; s=open(p).read()
s,n=re.subn(r"np: u\.dodgeRun > 0 && u\.quietTurns > 0 && st\.hpTick === u\.hpSeen \? Math\.min\(u\.dodgeRun, u\.quietTurns\) : undefined,", "np: noProgressTurns(st, u) || undefined,", s)
assert n==1
open(p,'w').write(s)
PY
fi
node -e "const r=require('fs').realpathSync('node_modules/@montecrit/engine');if(!r.startsWith(require('fs').realpathSync(process.cwd())))throw new Error('tree vs tree: '+r);console.log('engine link inside the copy')"
if [ -n "${STRESS_V8_FLAGS:-}" ]; then
  python3 -I - "$STRESS_V8_FLAGS" <<'PY'
import json,sys
open('vitest.config.ts','w').write("import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'], execArgv: %s } });\n" % json.dumps(sys.argv[1].split()))
PY
fi
fail=0; total=0
for round in $(seq 1 "$ROUNDS"); do
  pids=(); 
  for i in $(seq 1 "$PROCS"); do
    ( MONTECRIT_STRESS_RUNS=400 MONTECRIT_HOME=$(mktemp -d) npx vitest run packages/engine/test/sim-replay.test.ts -t 'same replay key' --testTimeout=600000 > "$C/p$round-$i.log" 2>&1 ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do total=$((total+1)); wait "$p" || fail=$((fail+1)); done
done
echo "replay-key property x 400 runs: $fail of $total processes failed ($MODE text, node $(node -v), V8 flags: ${STRESS_V8_FLAGS:-none})"
pids=(); cw=0
for i in $(seq 1 "$PROCS"); do
  ( MONTECRIT_HOME=$(mktemp -d) node tools/stress-cold-warm.ts > "$C/cw$i.log" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || cw=$((cw+1)); done
echo "cold vs warm, sink on vs off: $cw of $PROCS processes differed; $(cat "$C"/cw1.log | tail -1)"
[ "$fail" -eq 0 ] && [ "$cw" -eq 0 ]
