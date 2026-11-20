// The Character screen's state, kept by the app shell so a tab switch doesn't lose it: the picked
// file (or the pick form's draft), the form, and the pane's unsaved edits per file. Pure: every
// change is a function of the state and an action. Nothing is persisted (decision 4: no
// write-back; a reload of the page starts over).

import type { CharacterForm } from './form.ts';

/** The drafts key of the pick form's pane. */
export const FORM_KEY = '';

export interface ScreenState {
  /** The picked file's path; null for the pick form's draft. */
  readonly path: string | null;
  readonly form: CharacterForm | null;
  /** The pane's text per key (a file's path, or FORM_KEY), only where it differs from the file. */
  readonly drafts: Readonly<Record<string, string>>;
  /** The picked file's text when it was last seen loaded: the pane keeps it if the file goes away. */
  readonly seen: Readonly<Record<string, string>>;
}

export type ScreenAction =
  /** Pick a loaded file (its current text). */
  | { readonly t: 'pick'; readonly path: string; readonly text: string }
  /** Pick "New, from the pick form": restores the draft; `form`/`text` are used only when there is none. */
  | { readonly t: 'new'; readonly form: CharacterForm; readonly text: string }
  /** The pane was typed in; `file` is the picked file's text (null for the form draft or a file no longer loaded). */
  | { readonly t: 'edit'; readonly text: string; readonly file: string | null }
  /** The form changed: it rewrites the form draft's pane. */
  | { readonly t: 'form'; readonly form: CharacterForm; readonly text: string }
  /** Drop the pane's edits for the current key. */
  | { readonly t: 'revert' }
  /** The picked file is loaded with this text (kept for when it goes away). */
  | { readonly t: 'seen'; readonly path: string; readonly text: string };

export function initialScreen(firstPath: string | null, firstText: string): ScreenState {
  return { path: firstPath, form: null, drafts: {}, seen: firstPath === null ? {} : { [firstPath]: firstText } };
}

const keyOf = (s: ScreenState): string => s.path ?? FORM_KEY;

function without(r: Readonly<Record<string, string>>, k: string): Record<string, string> {
  const out: Record<string, string> = { ...r };
  delete out[k];
  return out;
}

export function reduceScreen(s: ScreenState, a: ScreenAction): ScreenState {
  switch (a.t) {
    case 'pick':
      return { ...s, path: a.path, seen: { ...s.seen, [a.path]: a.text } };
    case 'new':
      if (Object.hasOwn(s.drafts, FORM_KEY) && s.form !== null) return { ...s, path: null };
      return { ...s, path: null, form: s.form ?? a.form, drafts: { ...s.drafts, [FORM_KEY]: a.text } };
    case 'edit': {
      const k = keyOf(s);
      // A file's pane equal to the file again is not an edit.
      if (s.path !== null && a.file !== null && a.text === a.file) return { ...s, drafts: without(s.drafts, k) };
      return { ...s, drafts: { ...s.drafts, [k]: a.text } };
    }
    case 'form':
      return { ...s, form: a.form, drafts: { ...s.drafts, [FORM_KEY]: a.text } };
    case 'revert':
      return s.path === null ? s : { ...s, drafts: without(s.drafts, s.path) };
    case 'seen':
      return s.seen[a.path] === a.text ? s : { ...s, seen: { ...s.seen, [a.path]: a.text } };
  }
}

export interface PaneView {
  readonly text: string;
  /** The file to revert to (or the form's YAML for the form draft); null when there is nothing to compare. */
  readonly base: string | null;
  /** The pane differs from its base: "edited (not saved)". */
  readonly edited: boolean;
  /** The picked file isn't in the loaded content (any more). */
  readonly missing: boolean;
}

/**
 * What the pane shows. `fileText` is the picked file's current text (null when it isn't loaded);
 * `formText` the pick form's YAML (null without a form). A file that goes away keeps its pane: the
 * edits, else the text last seen; nothing falls back to another character.
 */
export function paneView(s: ScreenState, fileText: string | null, formText: string | null): PaneView {
  if (s.path === null) {
    const text = s.drafts[FORM_KEY] ?? formText ?? '';
    return { text, base: formText, edited: formText !== null && text !== formText, missing: false };
  }
  const base = fileText ?? s.seen[s.path] ?? null;
  const draft = s.drafts[s.path];
  const text = draft ?? base ?? '';
  return { text, base, edited: draft !== undefined && draft !== base, missing: fileText === null };
}
