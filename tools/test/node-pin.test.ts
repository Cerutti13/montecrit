// The goldens and hashes were proved on one Node (coverage.md 8'b review, determinism-1: a V8 Maglev
// miscompile was seen at one expression in stateHash on v26.9.0, gone under --no-maglev). A Node bump
// reruns the stress in the note first, then moves all of these together.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('the Node version is pinned', () => {
  it('.nvmrc, package.json engines, the lockfile root and CI name one exact version, and this run is on it', () => {
    const pin = read('.nvmrc').trim();
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(read('package.json')).engines.node).toBe(pin);
    expect(JSON.parse(read('package-lock.json')).packages[''].engines.node).toBe(pin);
    expect(read('.github/workflows/ci.yml')).toMatch(/node-version-file: \.nvmrc/);
    expect(process.version).toBe(`v${pin}`);
  });
});
