// The Character screen (docs/design/m3.md 10, "Web"; PLAN.md UI screen 6): pick a loaded
// character (a bundled one, or the private home's under `npm run web`) or build one with the pick
// form; a live YAML pane checked as you type (YAML, schema, character lint, then a debounced
// compile check); the derived sheet; "Download YAML". Decision 4: no write-back, the download is
// the only way out, and nothing is stored. The screen's state (pick, form, unsaved edits per file)
// lives in the app shell (screen-state.ts), so a tab switch or a home reload keeps it.

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ContentSet } from '../content/select.ts';
import { FormBuilder } from './FormBuilder.tsx';
import { defaultForm, formToYaml, type CharacterForm } from './form.ts';
import { characterLib } from './lib.ts';
import { SheetView } from './SheetView.tsx';
import { initialScreen, paneView, reduceScreen, type ScreenAction, type ScreenState } from './screen-state.ts';
import { checkCharacter, compileCheck, downloadName, isEmptyPane, listCharacters, packDirs, paneStatus, type CompileResult, type Issue } from './validate.ts';

const COMPILE_DELAY_MS = 400;
const PRIV_NS = 'priv' + 'ate';

function IssueList({ title, issues }: { title: string; issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="issues">
      <h3>{title}</h3>
      <ul className="tight">
        {issues.map((is, i) => (
          <li key={i} className={is.severity === 'error' ? 'bad' : 'warn'}>
            {is.severity}
            {is.line > 0 ? ` at line ${is.line}` : ''}
            {is.path !== '' && (
              <>
                {', '}
                <code>{is.path}</code>
              </>
            )}
            : {is.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface CharacterScreenProps {
  readonly set: ContentSet;
  /** The home folder is (re)loading: a picked home file missing now may come back. */
  readonly homeLoading?: boolean;
  /** The screen's state, kept by the app shell (null until the first change); without it the screen keeps its own. */
  readonly state?: ScreenState | null;
  readonly setState?: Dispatch<SetStateAction<ScreenState | null>>;
}

export function CharacterScreen({ set, homeLoading = false, state: lifted, setState: setLifted }: CharacterScreenProps) {
  const lib = useMemo(() => characterLib(set.packs), [set]);
  const list = useMemo(() => listCharacters(set.packs), [set]);
  const draftId = useMemo(() => `${packDirs(set.packs).has(PRIV_NS) ? PRIV_NS : 'test'}:new-character`, [set]);
  const [local, setLocal] = useState<ScreenState | null>(null);
  const raw = setLifted ? (lifted ?? null) : local;
  const setRaw = setLifted ?? setLocal;
  const init = useMemo(() => {
    const first = list.find((c) => c.kind === 'character') ?? null;
    return initialScreen(first?.path ?? null, first?.text ?? '');
  }, [list]);
  const st = raw ?? init;
  const dispatch = useCallback((a: ScreenAction) => setRaw((cur) => reduceScreen(cur ?? init, a)), [setRaw, init]);

  const path = st.path;
  const entry = path !== null ? (list.find((c) => c.path === path) ?? null) : null;
  const formText = useMemo(() => (st.form !== null ? formToYaml(lib, st.form) : null), [lib, st.form]);
  const view = paneView(st, entry?.text ?? null, formText);
  const text = view.text;
  // Remember the picked file's text, so the pane keeps it if a home reload drops the file. A
  // missing file never sends the screen to another character (nothing is overwritten).
  useEffect(() => {
    if (entry !== null && st.seen[entry.path] !== entry.text) dispatch({ t: 'seen', path: entry.path, text: entry.text });
  }, [entry, st.seen, dispatch]);

  const check = useMemo(() => checkCharacter(text, lib, path ?? 'draft.yaml'), [text, lib, path]);
  const clean = check.yaml.length === 0 && check.schema.length === 0 && check.kind !== null;
  const [compiled, setCompiled] = useState<{ text: string; r: CompileResult } | null>(null);
  useEffect(() => {
    if (!clean) return;
    const t = setTimeout(() => setCompiled({ text, r: compileCheck(text, check.id, set.packs, path, check.lint) }), COMPILE_DELAY_MS);
    return () => clearTimeout(t);
  }, [clean, text, check, set, path]);
  const fresh = compiled !== null && compiled.text === text && clean ? compiled.r : null;
  const sheet = fresh?.sheet ?? check.sheet;
  const homePath = path !== null && path.startsWith('home/');
  const isPrivate = entry?.origin === 'home' || (view.missing && homePath) || check.privateText;

  const pick = (p: string) => {
    if (p === '') {
      const f = st.form ?? defaultForm(lib, draftId);
      dispatch({ t: 'new', form: f, text: formToYaml(lib, f) });
      return;
    }
    dispatch({ t: 'pick', path: p, text: list.find((c) => c.path === p)?.text ?? '' });
  };
  const changeForm = (f: CharacterForm) => dispatch({ t: 'form', form: f, text: formToYaml(lib, f) });
  const revert = () => {
    if (path !== null) dispatch({ t: 'revert' });
    else if (st.form !== null && formText !== null) dispatch({ t: 'form', form: st.form, text: formText });
  };
  const errors = check.yaml.length + check.schema.length + check.lint.filter((i) => i.severity === 'error').length + (fresh?.issues.filter((i) => i.severity === 'error').length ?? 0);
  const warnings = check.lint.filter((i) => i.severity === 'warning').length + (fresh?.issues.filter((i) => i.severity === 'warning').length ?? 0);
  const edited = (p: string) => (Object.hasOwn(st.drafts, p) ? ' · edited' : '');

  return (
    <section className="character" aria-label="Character">
      <h2>Character</h2>
      <div className="form">
        <label>
          Character{' '}
          <select value={path ?? ''} onChange={(e) => pick(e.target.value)}>
            <option value="">New, from the pick form</option>
            {view.missing && path !== null && <option value={path}>(not loaded) {path}{edited(path)}</option>}
            {(['character', 'pc'] as const).map((k) => (
              <optgroup key={k} label={k === 'character' ? 'kind: character' : 'kind: pc (hand-filled sheets)'}>
                {list
                  .filter((c) => c.kind === k)
                  .map((c) => (
                    <option key={c.path} value={c.path}>
                      {c.origin === 'home' ? 'PRIVATE · ' : ''}
                      {c.name} ({c.id}){edited(c.path)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {view.edited && (
          <>
            <span className="warn">edited (not saved)</span>
            <button type="button" onClick={revert}>
              {path !== null ? 'Revert to the file' : 'Revert to the form'}
            </button>
          </>
        )}
        <button type="button" onClick={() => download(text, downloadName(check.id))} disabled={isEmptyPane(text)}>
          Download YAML
        </button>
        <span className="muted">{downloadName(check.id)}: nothing is written anywhere else</span>
      </div>
      {view.missing && path !== null && (
        <p className="note warn" role="status">
          {homeLoading ? `${path} isn't loaded while the home folder reloads; the pane keeps its text.` : `${path} is no longer loaded; the pane keeps its text (Download YAML to keep it).`}
        </p>
      )}
      {isPrivate && (
        <div className="chipbar private" role="status">
          PRIVATE · {homePath ? `from the home folder (${path})` : entry?.origin === 'home' ? `its pack is private (${entry.path})` : 'this text carries a private id or license'}; it stays in this page and the download
        </div>
      )}
      {path === null && st.form !== null && <FormBuilder lib={lib} form={st.form} onChange={changeForm} />}
      <div className="chargrid">
        <div>
          <h3>
            <label htmlFor="character-yaml">YAML{path !== null ? ` · ${path}` : ' · draft'}</label>
          </h3>
          <textarea
            id="character-yaml"
            className="yaml mono"
            value={text}
            onChange={(e) => dispatch({ t: 'edit', text: e.target.value, file: entry?.text ?? null })}
            spellCheck={false}
            aria-describedby="character-status"
            aria-invalid={errors > 0}
            rows={32}
          />
          {path === null && st.form !== null && <p className="note">Changing the form rewrites this pane; edit the YAML after the form is done.</p>}
        </div>
        <div>
          <p id="character-status" role="status" aria-live="polite" className={errors > 0 ? 'bad' : undefined}>
            {paneStatus(text, errors, warnings, clean, fresh)}
          </p>
          <IssueList title="YAML" issues={check.yaml} />
          <IssueList title="Schema" issues={check.schema} />
          <IssueList title="Character lint" issues={check.lint} />
          {fresh && <IssueList title="Compile check" issues={fresh.issues} />}
          {fresh !== null && fresh.elsewhere > 0 && <p className="bad">Other content has {fresh.elsewhere} error(s); run montecrit lint.</p>}
          {check.kind === 'pc' && <p className="note">A kind: pc is a hand-filled sheet with no derivation; montecrit migrate drafts a kind: character from it.</p>}
          {sheet ? <SheetView sheet={sheet} /> : check.kind === 'character' && <p className="note">No sheet: fix the errors above.</p>}
        </div>
      </div>
    </section>
  );
}
