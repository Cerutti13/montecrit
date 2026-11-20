#!/usr/bin/env node
import { ExprError } from '@montecrit/engine';
import { runLint, type CommandOutput } from './lint.ts';
import { RUN_USAGE, runRunAsync } from './run.ts';
import { WorkerError } from './report.ts';
import { ODDS_USAGE, UsageError, runOdds } from './odds.ts';
import { runSchema } from './schema.ts';
import { SHEET_USAGE, runSheet } from './sheet.ts';
import { BUILD_USAGE, NEW_USAGE, runBuild, runNewCharacter } from './character.ts';
import { MIGRATE_USAGE, runMigrate } from './migrate.ts';

const USAGE = `usage: montecrit <command> [options]

commands:
  odds    exact chance to pass a d20 test (montecrit odds --help)
  sheet   a creature's derived numbers, hit odds and expected damage (montecrit sheet --help)
  lint    check packs, scenarios and journals (montecrit lint --help)
  schema  write JSON Schemas for content files to schemas/
  run     one seeded fight, printed as a log (montecrit run --help); --pc SEAT=CHAR drops a character into a seat
  build   a kind: character file's derived sheet: every number's source, each feature's fidelity (montecrit build --help)
  new     new character --class ID --level N --out F: a skeleton with every pick as a commented list (montecrit new --help)
  migrate draft a kind: character from a kind: pc file and diff the two templates (montecrit migrate --help)

run -n N or --policy a,b,... prints a Monte Carlo report; coming next: compare`;

const [cmd, ...rest] = process.argv.slice(2);

function emit(o: CommandOutput): void {
  if (o.out) console.log(o.out);
  if (o.err) console.error(o.err);
  if (o.code !== 0) process.exitCode = o.code;
}

try {
  if (cmd === 'odds') {
    if (rest.includes('--help')) console.log(ODDS_USAGE);
    else {
      const out = runOdds(rest);
      console.log(out.text);
      if (!out.agrees) process.exitCode = 1;
    }
  } else if (cmd === 'sheet') {
    emit(rest.length === 0 ? { out: '', err: SHEET_USAGE, code: 2 } : runSheet(rest));
  } else if (cmd === 'lint') {
    emit(runLint(rest));
  } else if (cmd === 'run') {
    emit(rest.length === 0 ? { out: '', err: RUN_USAGE, code: 2 } : await runRunAsync(rest));
  } else if (cmd === 'build') {
    emit(rest.length === 0 ? { out: '', err: BUILD_USAGE, code: 2 } : runBuild(rest));
  } else if (cmd === 'new') {
    emit(rest.length === 0 ? { out: '', err: NEW_USAGE, code: 2 } : runNewCharacter(rest));
  } else if (cmd === 'migrate') {
    emit(rest.length === 0 ? { out: '', err: MIGRATE_USAGE, code: 2 } : runMigrate(rest));
  } else if (cmd === 'schema') {
    emit(runSchema(rest));
  } else if (cmd === undefined || cmd === '--help' || cmd === 'help') {
    console.log(USAGE);
  } else {
    console.error(`unknown command "${cmd}"\n\n${USAGE}`);
    process.exitCode = 2;
  }
} catch (e) {
  if (e instanceof WorkerError) {
    // A worker that failed is a message (plus the worker's own stack when it crashed), exit 1.
    console.error(`montecrit: ${e.message}${e.detail ? `\n${e.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    // Bad input gets a one-line message; anything else is a bug and keeps its stack.
    const known = e instanceof UsageError || e instanceof ExprError || (e instanceof Error && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS'));
    if (!known) throw e;
    console.error(`montecrit: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
