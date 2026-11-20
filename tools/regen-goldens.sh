#!/bin/bash
# Regenerate or check every scenarios/golden output through the CLI and tooling (coverage.md M10).
# Never hand-edit a golden.
#   tools/regen-goldens.sh write        regenerate IN PLACE: journals re-stamped from what --record
#                                       writes (engine, contentHash, scenarioHash: only the keys the
#                                       journal carries), seed logs via --update-golden, the n40 report
#                                       + its --report-hash, the Monk build text, flag matrices via
#                                       UPDATE_FLAG_MATRIX=1 on the test harness.
#   tools/regen-goldens.sh check OUT    regenerate into OUT (repo untouched) and cmp with
#                                       scenarios/golden; journals: --record stamp vs the golden's;
#                                       the 11 flag matrices through their own test, which compares
#                                       them against a fresh run. Exits 1 on any difference.
# Both modes exit non-zero when anything failed, so a clean exit is the proof.
# Every CLI call runs with MONTECRIT_HOME=$(mktemp -d), so the private home is never read.
set -euo pipefail
MODE=$1; R=$(cd "$(dirname "$0")/.." && pwd); G=$R/scenarios/golden
cd "$R"
export MONTECRIT_HOME=$(mktemp -d)
CLI="node apps/cli/src/main.ts"
TMP=$(mktemp -d)
FAILED=0
restamp() { # $1 golden journal, $2 recorded journal: copy the recorder's stamp keys into the golden
  python3 -I - "$1" "$2" <<'PY'
import re,sys
j,r=sys.argv[1],sys.argv[2]
rec=dict(re.findall(r'^(engine|contentHash|scenarioHash): (.*)$', open(r).read(), re.M))
s=open(j).read()
for k,v in rec.items():
  bare=v.strip().strip('"').strip("'")
  # keep the golden's own quote character, so only the value moves
  s=re.sub(r'^%s: (["\']?).*?\1$'%k, lambda m: '%s: %s%s%s'%(k, m.group(1), bare, m.group(1)), s, flags=re.M)
open(j,'w').write(s)
PY
}
if [ "$MODE" = write ]; then
  for j in $G/*.journal.yaml; do
    name=$(basename "$j" .journal.yaml); seed=$(grep -E '^seed: ' "$j" | sed 's/seed: //')
    $CLI run "$G/$name.yaml" --seed "$seed" --journal "$j" --record "$TMP/$name.rec.yaml" > /dev/null 2>"$TMP/$name.err" || { echo "RC record $name"; cat "$TMP/$name.err"; FAILED=1; }
    restamp "$j" "$TMP/$name.rec.yaml"
    # second pass: the stamp is now current, so --record must write the same stamp again
    $CLI run "$G/$name.yaml" --seed "$seed" --journal "$j" --record "$TMP/$name.rec2.yaml" > /dev/null 2>&1
    keys=$(grep -oE '^(engine|contentHash|scenarioHash):' "$j" | tr -d ':' | paste -sd'|' -)
    stamp() { grep -E "^($keys): " "$1" | tr -d "'\""; }
    if [ "$(stamp "$TMP/$name.rec2.yaml")" = "$(stamp "$j")" ]; then echo "journal re-stamped = --record  $name"; else echo "JOURNAL STAMP DIFFERS $name"; FAILED=1; fi
  done
  for f in $G/*.seed*.log; do
    b=$(basename "$f"); name=${b%%.seed*}; seed=${b#*.seed}; seed=${seed%.log}
    $CLI run "$G/$name.yaml" --seed "$seed" --journal "$G/$name.journal.yaml" --update-golden "$f" > /dev/null 2>"$TMP/$b.err" || { echo "RC update-golden $b"; cat "$TMP/$b.err"; FAILED=1; }
    [ -s "$TMP/$b.err" ] && { echo "stderr $b:"; cat "$TMP/$b.err"; }
    echo "log via --update-golden  $b"
  done
  $CLI run stars-ambush -n 40 --policy greedy,moonbeam-first --chunk 20 --report-hash > "$TMP/report.all"
  python3 -I -c 'import sys; t=open(sys.argv[1]).read(); i=t.index("\nreport-hash "); open(sys.argv[2],"w").write(t[:i]); open(sys.argv[3],"w").write(t[i+1:])' "$TMP/report.all" "$G/stars-ambush.report.n40.txt" "$G/stars-ambush.report.n40.hash"
  echo "n40 report + hash via run -n 40 --report-hash"
  $CLI build packs/test/characters/sample-monk.yaml > "$G/sample-monk.build.txt"
  echo "sample-monk.build.txt via build"
  if UPDATE_FLAG_MATRIX=1 npx vitest run apps/cli/test/flag-matrix.test.ts > "$TMP/matrix.out" 2>&1; then
    echo "flag matrices via UPDATE_FLAG_MATRIX=1"
  else
    echo "FLAG MATRIX REGENERATION FAILED"; tail -30 "$TMP/matrix.out"; FAILED=1
  fi
  rm -rf "$TMP"
  git status --short -- scenarios || true
  exit $FAILED
fi
OUT=$2; rm -rf "$OUT"; mkdir -p "$OUT"
for f in $G/*.seed*.log; do
  b=$(basename "$f"); name=${b%%.seed*}; seed=${b#*.seed}; seed=${seed%.log}
  $CLI run "$G/$name.yaml" --seed "$seed" --journal "$G/$name.journal.yaml" > "$OUT/$b"
done
for j in $G/*.journal.yaml; do
  b=$(basename "$j"); name=${b%.journal.yaml}
  seed=$(grep -E '^seed: ' "$j" | sed 's/seed: //')
  $CLI run "$G/$name.yaml" --seed "$seed" --journal "$j" --record "$OUT/$name.recorded.yaml" > /dev/null
  keys=$(grep -oE '^(engine|contentHash|scenarioHash):' "$j" | tr -d ':' | paste -sd'|' -)
  stamp() { grep -E "^($keys): " "$1" | tr -d "'\""; }
  if [ "$(stamp "$OUT/$name.recorded.yaml")" = "$(stamp "$j")" ]; then echo "journal stamp = --record  $b"; else echo "JOURNAL STAMP DIFFERS $b"; FAILED=1; fi
done
$CLI run stars-ambush -n 40 --policy greedy,moonbeam-first --chunk 20 --report-hash > "$OUT/report.all"
python3 -I -c 'import sys; t=open(sys.argv[1]).read(); i=t.index("\nreport-hash "); open(sys.argv[2],"w").write(t[:i]); open(sys.argv[3],"w").write(t[i+1:])' "$OUT/report.all" "$OUT/stars-ambush.report.n40.txt" "$OUT/stars-ambush.report.n40.hash"; rm "$OUT/report.all"
$CLI build packs/test/characters/sample-monk.yaml > "$OUT/sample-monk.build.txt"
n=0; bad=0
for f in "$OUT"/*.log "$OUT"/*.txt "$OUT"/*.hash; do b=$(basename "$f"); n=$((n+1)); if ! cmp -s "$f" "$G/$b"; then echo "DIFF $b"; bad=$((bad+1)); fi; done
echo "regenerated and compared $n files, $bad differ"
# The matrices: their own test regenerates each and compares it with the golden.
m=$(ls "$G"/*.flag-matrix.log | wc -l | tr -d ' ')
if npx vitest run apps/cli/test/flag-matrix.test.ts > "$OUT/matrix.out" 2>&1; then
  echo "flag matrices: $m checked by flag-matrix.test.ts, passed"
else
  echo "FLAG MATRICES DIFFER: $m checked by flag-matrix.test.ts"; tail -30 "$OUT/matrix.out"; FAILED=1
fi
if [ "$bad" -gt 0 ]; then FAILED=1; fi
exit $FAILED
