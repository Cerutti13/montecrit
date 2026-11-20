// The replay controller (docs/design/m2.md 4.4): which frame is showing and how the scrubber,
// the keys and play move it. Pure (no DOM), so it's tested without a browser. Frames are
// ViewFrames' (frames[0] the start, frames[i + 1] after events[i]).

export type Speed = 1 | 4 | 16;

export interface ReplayState {
  readonly i: number;
  readonly playing: boolean;
  readonly speed: Speed;
  /** The event whose WHY chain is open (its seq), or null. */
  readonly selected: number | null;
}

export type ReplayAction =
  | { readonly t: 'stepEvent' | 'stepTurn' | 'stepRound'; readonly d: 1 | -1 }
  | { readonly t: 'seek'; readonly i: number }
  | { readonly t: 'home' | 'end' | 'toggle' | 'tick' }
  | { readonly t: 'speed'; readonly speed: Speed }
  | { readonly t: 'select'; readonly seq: number | null };

export interface Tables {
  /** The last frame index. */
  readonly last: number;
  /** Frame indices right after each turnStart and roundStart, ascending. */
  readonly turnStarts: readonly number[];
  readonly roundStarts: readonly number[];
  /** Per frame: whether play skips it (frames after a `decided` event). */
  readonly skip: readonly boolean[];
}

export const initial: ReplayState = { i: 0, playing: false, speed: 1, selected: null };

const clamp = (i: number, last: number) => Math.max(0, Math.min(last, i));

function jump(marks: readonly number[], i: number, d: 1 | -1, last: number): number {
  if (d > 0) {
    for (const m of marks) if (m > i) return m;
    return last;
  }
  for (let k = marks.length - 1; k >= 0; k--) if (marks[k]! < i) return marks[k]!;
  return 0;
}

export function reduce(t: Tables, s: ReplayState, a: ReplayAction): ReplayState {
  switch (a.t) {
    case 'stepEvent':
      return { ...s, playing: false, i: clamp(s.i + a.d, t.last) };
    case 'stepTurn':
      return { ...s, playing: false, i: jump(t.turnStarts, s.i, a.d, t.last) };
    case 'stepRound':
      return { ...s, playing: false, i: jump(t.roundStarts, s.i, a.d, t.last) };
    case 'seek':
      return { ...s, i: clamp(a.i, t.last) };
    case 'home':
      return { ...s, playing: false, i: 0 };
    case 'end':
      return { ...s, playing: false, i: t.last };
    case 'toggle':
      if (s.playing) return { ...s, playing: false };
      return { ...s, playing: true, i: s.i >= t.last ? 0 : s.i };
    case 'tick': {
      if (!s.playing) return s;
      let i = s.i + 1;
      while (i < t.last && t.skip[i]) i++;
      i = clamp(i, t.last);
      return { ...s, i, playing: i < t.last };
    }
    case 'speed':
      return { ...s, speed: a.speed };
    case 'select':
      return { ...s, selected: a.seq };
  }
}

/** How long play shows a frame: a step briefly, anything else longer; faster at higher speeds. */
export function delayFor(kind: string | undefined, speed: Speed): number {
  return (kind === 'step' ? 80 : 250) / speed;
}

// ---- Condition markers (docs/design/m3.md 10): what the map badges on a token at this frame ----

export interface CondMarker {
  /** The condition id (`core:prone`), or `conc` for concentration. */
  readonly id: string;
  /** Two letters on the token. */
  readonly abbr: string;
  /** The full name, for the title and the aria label. */
  readonly name: string;
}

/**
 * Every condition the engine carries (sim/state.ts COND_IDS) plus Grappled for when it lands,
 * most decisive first: that order is the order on the token, so a crowded badge row still shows
 * what matters. Two letters each, since one letter can't tell Prone, Paralyzed and Poisoned apart.
 */
const KNOWN: readonly (readonly [string, string, string])[] = [
  ['core:unconscious', 'Un', 'Unconscious'],
  ['core:paralyzed', 'Pa', 'Paralyzed'],
  ['core:stunned', 'St', 'Stunned'],
  ['core:incapacitated', 'In', 'Incapacitated'],
  ['core:restrained', 'Re', 'Restrained'],
  ['core:grappled', 'Gr', 'Grappled'],
  ['core:prone', 'Pr', 'Prone'],
  ['core:blinded', 'Bl', 'Blinded'],
  ['core:frightened', 'Fr', 'Frightened'],
  ['core:charmed', 'Ch', 'Charmed'],
  ['core:poisoned', 'Po', 'Poisoned'],
  ['core:dodging', 'Do', 'Dodging'],
  ['core:disengaged', 'Di', 'Disengaged'],
];

/** `core:some-thing` -> `Some thing`; an id with no namespace is used as is. */
function nameOf(id: string): string {
  const local = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const words = local.replace(/-/g, ' ');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

/**
 * The markers for one token: its conditions (known ones in KNOWN's order, any other id after
 * them in the order given, named from its id rather than guessed), then concentration when
 * `conc` >= 0, named after the effect when `concName` is given. Duplicates are dropped.
 */
export function condMarkers(conds: readonly string[], conc: number, concName?: string): CondMarker[] {
  const out: CondMarker[] = [];
  for (const [id, abbr, name] of KNOWN) if (conds.includes(id)) out.push({ id, abbr, name });
  for (const id of conds) {
    if (out.some((m) => m.id === id)) continue;
    const name = nameOf(id);
    out.push({ id, abbr: name.slice(0, 2), name });
  }
  if (conc >= 0) out.push({ id: 'conc', abbr: 'C', name: concName ? `Concentrating on ${concName}` : 'Concentrating' });
  return out;
}
