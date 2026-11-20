// tools/regen-goldens.sh's exit status is the proof a build note cites (coverage.md 8'b review,
// integration-2): a clean exit means every output matched. The CLI and vitest are stubbed on PATH;
// the script itself runs for real on a throwaway tree, so this is fast and touches no golden.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');
const FAKE_NODE = `#!/bin/bash
# Stands in for the CLI: a run prints the matching golden (or a changed one, on request), --record writes a stamp.
shift # apps/cli/src/main.ts
cmd=$1; shift
if [ "$cmd" = build ]; then cat "$ROOT/scenarios/golden/sample-monk.build.txt"; exit 0; fi
target=$1; shift
if [ "$target" = stars-ambush ]; then
  cat "$ROOT/scenarios/golden/stars-ambush.report.n40.txt"; printf '\\n'; cat "$ROOT/scenarios/golden/stars-ambush.report.n40.hash"
  exit 0
fi
rec=""; upd=""
while [ $# -gt 0 ]; do
  case "$1" in
    --record) rec=$2; shift 2 ;;
    --update-golden) upd=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$rec" ]; then
  # FAKE_STAMP_SECOND: a recorder that writes a different stamp on the second pass (write mode's re-check).
  n=0; [ -f "$ROOT/.rec-count" ] && n=$(cat "$ROOT/.rec-count"); n=$((n + 1)); echo "$n" > "$ROOT/.rec-count"
  if [ -n "$FAKE_STAMP_SECOND" ] && [ "$n" -ge 2 ]; then printf 'engine: %s\\n' "$FAKE_STAMP_SECOND" > "$rec"; else printf 'engine: %s\\n' "\${FAKE_STAMP:-0.7.0}" > "$rec"; fi
  exit 0
fi
if [ -n "$upd" ]; then exit 0; fi
cat "$ROOT/scenarios/golden/a.seed1.log"
[ -z "$FAKE_LOG_DIFFERS" ] || echo changed
`;
const FAKE_NPX = `#!/bin/bash
echo "matrix run"
exit \${FAKE_MATRIX_RC:-0}
`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'regen-goldens-'));
  dirs.push(root);
  mkdirSync(join(root, 'tools'));
  cpSync(join(REPO, 'tools', 'regen-goldens.sh'), join(root, 'tools', 'regen-goldens.sh'));
  const g = join(root, 'scenarios', 'golden');
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, 'a.yaml'), 'kind: scenario\n');
  writeFileSync(join(g, 'a.journal.yaml'), 'seed: 1\nengine: 0.7.0\n');
  writeFileSync(join(g, 'a.seed1.log'), 'a log\n');
  writeFileSync(join(g, 'a.flag-matrix.log'), 'a matrix\n');
  writeFileSync(join(g, 'stars-ambush.report.n40.txt'), 'a report');
  writeFileSync(join(g, 'stars-ambush.report.n40.hash'), 'report-hash 0\n');
  writeFileSync(join(g, 'sample-monk.build.txt'), 'a sheet\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), FAKE_NODE);
  writeFileSync(join(bin, 'npx'), FAKE_NPX);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'npx'), 0o755);
  return { root, bin, out: join(root, 'out') };
}
function run(t: ReturnType<typeof tree>, mode: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(t.root, 'tools', 'regen-goldens.sh'), ...mode], { encoding: 'utf8', env: { PATH: `${t.bin}:${process.env.PATH}`, ROOT: t.root, HOME: t.root, ...env } });
  return { rc: r.status, out: r.stdout + r.stderr };
}

describe('tools/regen-goldens.sh exits non-zero when anything differs or fails', () => {
  it('check, everything equal: exit 0, and it says what it compared and that the matrices went through their test', () => {
    const t = tree();
    const r = run(t, ['check', t.out]);
    expect(r.out).toMatch(/regenerated and compared 4 files, 0 differ/);
    expect(r.out).toMatch(/flag matrices: 1 checked by flag-matrix.test.ts, passed/);
    expect(r.rc).toBe(0);
  });
  it('check, a golden differs: exit 1', () => {
    const t = tree();
    const r = run(t, ['check', t.out], { FAKE_LOG_DIFFERS: '1' });
    expect(r.out).toMatch(/DIFF a\.seed1\.log/);
    expect(r.rc).toBe(1);
  });
  it('check, a journal stamp differs: exit 1', () => {
    const t = tree();
    const r = run(t, ['check', t.out], { FAKE_STAMP: '9.9.9' });
    expect(r.out).toMatch(/JOURNAL STAMP DIFFERS/);
    expect(r.rc).toBe(1);
  });
  it('check, a matrix differs: exit 1; the matrices are not copied and compared to themselves', () => {
    const t = tree();
    const r = run(t, ['check', t.out], { FAKE_MATRIX_RC: '1' });
    expect(r.out).toMatch(/FLAG MATRICES DIFFER/);
    expect(r.rc).toBe(1);
  });
  it('write, the matrix regeneration fails: exit 1, and no line claims it was done', () => {
    const t = tree();
    const r = run(t, ['write'], { FAKE_MATRIX_RC: '1' });
    expect(r.out).toMatch(/FLAG MATRIX REGENERATION FAILED/);
    expect(r.out).not.toMatch(/flag matrices via UPDATE_FLAG_MATRIX=1/);
    expect(r.rc).toBe(1);
  });
  it('write, the stamp it just wrote is not what --record writes: exit 1', () => {
    const t = tree();
    const r = run(t, ['write'], { FAKE_STAMP_SECOND: '9.9.9' });
    expect(r.out).toMatch(/JOURNAL STAMP DIFFERS a/);
    expect(r.rc).toBe(1);
  });
  it('write, all well: exit 0', () => {
    const t = tree();
    const r = run(t, ['write']);
    expect(r.out).toMatch(/flag matrices via UPDATE_FLAG_MATRIX=1/);
    expect(r.rc).toBe(0);
    expect(readFileSync(join(t.root, 'scenarios', 'golden', 'a.journal.yaml'), 'utf8')).toBe('seed: 1\nengine: 0.7.0\n');
  });
});
