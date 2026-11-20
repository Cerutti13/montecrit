// Copies tools/hooks/* into .git/hooks. Runs on `npm install` (the "prepare" script).
// Writes straight into .git/hooks instead of setting core.hooksPath, so other tools that
// install their own hooks there (graphify's post-commit) keep working.
import { copyFileSync, chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const gitHooks = join(root, '.git', 'hooks');
const ours = join(root, 'tools', 'hooks');
const MARKER = 'montecrit managed hook';

if (!existsSync(gitHooks)) {
  console.log('install-hooks: no .git/hooks yet, skipping');
} else {
  for (const name of readdirSync(ours)) {
    const dest = join(gitHooks, name);
    if (existsSync(dest) && !readFileSync(dest, 'utf8').includes(MARKER)) {
      console.warn(`install-hooks: ${dest} exists and isn't ours, leaving it alone`);
      continue;
    }
    copyFileSync(join(ours, name), dest);
    chmodSync(dest, 0o755);
    console.log(`install-hooks: installed ${name}`);
  }
}
