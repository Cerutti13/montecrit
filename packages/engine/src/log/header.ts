// The one-fight header: everything a fight's log depends on (replay key, policies, knobs, every
// rule flag it read, stubs and placeholders). Moved from apps/cli/src/run.ts (docs/design/m2.md
// 1) so the browser's replay viewer prints the same lines as `montecrit run`.

import { losNote } from '../sim/cover.ts';
import type { JournalEntry } from '../replay.ts';
import { describeFlags } from '../rules/flags.ts';
import type { FightSetup } from '../sim/setup.ts';
import { flagsUsedKeys } from '../sim/state.ts';
import { ENGINE_VERSION } from '../version.ts';

/** The report header: everything the log's numbers depend on. */
export function header(setup: FightSetup, seed: number, run: number, journal: readonly JournalEntry[], deciderNames: readonly string[], flagsUsed: Uint8Array, castIds: readonly string[] = [], fileNotes: readonly string[] = []): string[] {
  const k = setup.knobs;
  const used = flagsUsedKeys(flagsUsed);
  const policy = setup.seats.map((s, i) => `${s.seat} ${deciderNames[i]}`).join(' | ');
  const flagLines = used.length ? describeFlags(setup.flags, used).map((l) => `  ${l}`) : ['  (none read)'];
  const notes = [losNote(setup), ...fileNotes];
  if (setup.seats.some((s) => s.tpl.features.some((f) => f.preRoll !== null))) notes.push('initiative rolls: pre-roll reactions are not offered on them');
  if (setup.seats.some((s) => s.tpl.spells.length > 0 || s.tpl.features.length > 0)) notes.push('ending concentration or dismissing an effect: offered only on your own turn');
  for (const s of setup.seats) {
    if (s.tpl.placeholder) notes.push(`placeholder: ${s.tpl.id}`);
  }
  const seen = new Set<string>();
  for (const s of setup.seats) {
    if (seen.has(s.tpl.id)) continue;
    seen.add(s.tpl.id);
    if (s.tpl.fidelity !== 'full' || s.tpl.unimplemented.length) notes.push(`${s.tpl.id} ${s.tpl.fidelity}: unimplemented ${s.tpl.unimplemented.join('; ') || '(none listed)'}`);
  }
  // Spells actually cast this fight that aren't modeled in full.
  const castSeen = new Set<string>();
  for (const id of castIds) {
    if (castSeen.has(id)) continue;
    castSeen.add(id);
    const sp = setup.seats.flatMap((s) => s.tpl.spells).find((e) => e.spell.id === id)?.spell;
    if (sp && (sp.fidelity !== 'full' || sp.unimplemented.length)) notes.push(`${sp.id} ${sp.fidelity}: unimplemented ${sp.unimplemented.join('; ') || '(none listed)'}`);
  }
  return [
    `replay   engine ${ENGINE_VERSION} | content ${setup.contentHash} | scenario ${setup.scenario} ${setup.scenarioHash} | seed ${seed} run ${run} | journal ${journal.length}`,
    `policy   ${policy}`,
    `knobs    maxRounds=${k.maxRounds} attackDowned=${k.attackDowned} lossCounts=${k.lossCounts} downEnds=${k.downEnds}`,
    'flags read:',
    ...flagLines,
    ...notes.map((n) => `notes    ${n}`),
  ];
}
