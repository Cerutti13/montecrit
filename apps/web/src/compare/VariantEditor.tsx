// The variant editor (PLAN.md M6): a copy of a character with its build choices as selects (the
// subclass and every list pick the build asks for), the full YAML underneath for everything else,
// and the same live check as the Character screen. "Use this variant" is the screen's: it runs the
// compile check and adds the text to the content.

import { useMemo, useState } from 'react';
import type { SourceFile } from '@montecrit/engine';
import { AsiPickView } from '../character/FormBuilder.tsx';
import { pickValue, type AsiPick } from '../character/form.ts';
import { buildNeeds, characterLib } from '../character/lib.ts';
import { checkCharacter, type Issue } from '../character/validate.ts';
import { asiPick, asiValue, shiftAbilities, differences, nameOf, readCharacter, same, setCasting, setName, setPick, setPickValue, setSubclass, spellList, variantPath, type Variant } from './variant.ts';

const label = (o: { readonly id: string; readonly name: string | null }): string => (o.name ? `${o.name} (${o.id})` : o.id);
export interface VariantEditorProps {
  readonly packs: readonly SourceFile[];
  readonly draft: Variant;
  readonly baseName: string;
  readonly baseText: string;
  /** Problems the last "Use this variant" found when it compiled the text. */
  readonly refused: readonly Issue[];
  readonly onChange: (text: string) => void;
  readonly onUse: () => void;
  readonly onCancel: () => void;
}

export function VariantEditor({ packs, draft, baseName, baseText, refused, onChange, onUse, onCancel }: VariantEditorProps) {
  const lib = useMemo(() => characterLib(packs), [packs]);
  const text = draft.text;
  const check = useMemo(() => checkCharacter(text, lib, variantPath(draft.basePath, draft.n)), [text, lib, draft.basePath, draft.n]);
  const read = useMemo(() => readCharacter(text), [text]);
  const base = useMemo(() => readCharacter(baseText), [baseText]);
  const cls = read ? lib.classes.get(read.cls) : undefined;
  const subs = cls ? [...lib.subclasses.values()].filter((s) => s.parent === cls.id).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [];
  const sub = read && cls && read.level >= cls.subclassLevel ? subs.find((s) => s.id === read.subclass) : undefined;
  const needs = useMemo(() => (read && cls ? buildNeeds(lib, cls, sub, lib.species.get(read.species), lib.backgrounds.get(read.background), read.level) : []), [lib, read, cls, sub]);
  // A half-made increase (a kind picked, its abilities not yet): shown, but not in the text until it's whole.
  const [pending, setPending] = useState<Readonly<Record<string, AsiPick>>>({});
  const choices = needs.filter((n) => n.kind === 'choice' && n.options.length > 0);
  const increases = needs.filter((n) => n.kind !== 'choice');
  const spells = useMemo(() => spellList(packs), [packs]);
  const spellName = (id: string): string => spells.find((x) => x.id === id)?.name ?? id;
  // The highest spell level the character has slots for (the sheet's, so it needs a text that expands).
  const topLevel = check.sheet ? check.sheet.slots.levels.reduce((top, n, i) => (n > 0 ? i + 1 : top), 0) : 9;
  const issues: readonly Issue[] = [...check.yaml, ...check.schema, ...check.lint, ...refused];
  const errors = issues.filter((i) => i.severity === 'error').length;
  const diffs = differences(base, read, needs, (id) => lib.subclasses.get(id)?.name ?? spellName(id));
  const unchanged = text.replace(/^(id|name):.*$/gm, '') === baseText.replace(/^(id|name):.*$/gm, '');
  // A structured edit that can't be made on one line leaves the text alone; the YAML pane is the way then.
  const apply = (next: string | null) => {
    if (next !== null) onChange(next);
  };

  return (
    <fieldset className="encounter variant">
      <legend>Variant {draft.n}: a copy of {baseName}</legend>
      <div className="form">
        <label>
          Name{' '}
          <input type="text" value={nameOf(text) ?? ''} size={36} onChange={(e) => apply(setName(text, e.target.value))} />
        </label>
        {read && cls && subs.length > 0 && read.level >= cls.subclassLevel && (
          <label>
            Subclass{' '}
            <select value={read.subclass} onChange={(e) => apply(setSubclass(text, e.target.value))}>
              {!subs.some((s) => s.id === read.subclass) && <option value={read.subclass}>{read.subclass || '(none)'}</option>}
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {read === null && <p className="note">This text isn't a readable kind: character, so there are no selects: edit the YAML below.</p>}
      {choices.map((n) => {
        const cur = read?.picks[n.key] ?? [];
        const slots = Array.from({ length: Math.max(n.choose, cur.length) }, (_, i) => cur[i] ?? '');
        const changed = base !== null && !same(base.picks[n.key] ?? [], cur);
        const fixed = setPick(text, n.key, cur) === null;
        return (
          <fieldset className="pick" key={n.key}>
            <legend>
              {n.where}: choose {n.choose} ({n.what}){changed && <strong> · changed</strong>}
            </legend>
            {slots.map((v, i) => (
              <select
                key={i}
                aria-label={`${n.key} choice ${i + 1} of ${n.choose}`}
                value={v}
                disabled={fixed}
                onChange={(e) => {
                  const next = [...slots];
                  next[i] = e.target.value;
                  apply(setPick(text, n.key, next.filter((x) => x !== '')));
                }}
              >
                <option value="">(not chosen)</option>
                {!n.options.some((o) => o.id === v) && v !== '' && <option value={v}>{v}</option>}
                {n.options
                  .filter((o) => o.id === v || !slots.includes(o.id))
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {label(o)}
                    </option>
                  ))}
              </select>
            ))}
            {fixed && <span className="muted">written over several lines: change it in the YAML below</span>}
          </fieldset>
        );
      })}
      {increases.map((n) => {
        const bg = n.kind === 'abilities';
        const cur = read?.maps[n.key];
        // A background's increases are optional in a file whose scores are already final.
        if (bg && cur === undefined) return null;
        const fixed = (cur !== undefined && setPickValue(text, n.key, '{}') === null) || shiftAbilities(text, undefined, undefined) === null;
        return (
          <div key={n.key}>
            <AsiPickView
              n={n}
              value={pending[n.key] ?? asiPick(cur, bg)}
              onChange={(v) => {
                const yaml = pickValue(n, v);
                setPending((p) => {
                  const { [n.key]: _drop, ...rest } = p;
                  return yaml === null ? { ...rest, [n.key]: v } : rest;
                });
                if (yaml === null) return;
                // The file's scores are final, so the old increase comes out of them and the new one goes in.
                const picked = setPickValue(text, n.key, yaml);
                apply(picked === null ? null : shiftAbilities(picked, cur, asiValue(yaml)));
              }}
            />
            {fixed && <span className="muted">this pick or the abilities line is written over several lines: change them in the YAML below</span>}
          </div>
        );
      })}
      {(read?.casting ?? []).map((c) => {
        const sheet = check.sheet?.casting.find((x) => x.source === c.source);
        return (['cantrips', 'prepared'] as const).map((f) => {
          const cur = c[f];
          const want = f === 'cantrips' ? sheet?.cantripsExpected : sheet?.preparedExpected;
          const slots = Array.from({ length: Math.max(want ?? 0, cur.length) }, (_, i) => cur[i] ?? '');
          if (slots.length === 0) return null;
          const options = spells.filter((x) => (f === 'cantrips' ? x.level === 0 : x.level >= 1 && x.level <= topLevel));
          const was = base?.casting.find((x) => x.source === c.source)?.[f] ?? [];
          const fixed = setCasting(text, c.source, f, cur) === null;
          return (
            <fieldset className="pick" key={`${c.source}-${f}`}>
              <legend>
                {lib.classes.get(c.source)?.name ?? lib.subclasses.get(c.source)?.name ?? c.source}: {f === 'cantrips' ? 'cantrips' : 'prepared spells'}
                {want != null ? ` (${want})` : ''}
                {!same(was, cur) && <strong> · changed</strong>}
              </legend>
              {slots.map((v, i) => (
                <select
                  key={i}
                  aria-label={`${c.source} ${f} ${i + 1} of ${slots.length}`}
                  value={v}
                  disabled={fixed}
                  onChange={(e) => {
                    const next = [...slots];
                    next[i] = e.target.value;
                    apply(setCasting(text, c.source, f, next.filter((x) => x !== '')));
                  }}
                >
                  <option value="">(not chosen)</option>
                  {!options.some((o) => o.id === v) && v !== '' && <option value={v}>{spellName(v)}</option>}
                  {options
                    .filter((o) => o.id === v || !slots.includes(o.id))
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                        {f === 'prepared' ? ` (level ${o.level})` : ''}
                      </option>
                    ))}
                </select>
              ))}
              {fixed && <span className="muted">written over several lines: change it in the YAML below</span>}
            </fieldset>
          );
        });
      })}
      {(read?.casting.length ?? 0) > 0 && <p className="note">The spell lists offer every loaded spell of a level the character can cast, not only its class's list: the data doesn't carry class lists, so check the book.</p>}
      <details>
        <summary>Everything else: the YAML (equipment, ability scores, a feat's own picks)</summary>
        <textarea className="yaml mono" aria-label={`Variant ${draft.n} YAML`} value={text} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-invalid={errors > 0} rows={24} />
      </details>
      {issues.length > 0 && (
        <div className="issues">
          <ul className="tight">
            {issues.map((is, i) => (
              <li key={i} className={is.severity === 'error' ? 'bad' : 'warn'}>
                {is.severity}
                {is.line > 0 ? ` at line ${is.line}` : ''}
                {is.path !== '' ? `, ${is.path}` : ''}: {is.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="note" role="status">
        {unchanged ? `Nothing differs from ${baseName} yet.` : diffs.length > 0 ? `Changed from ${baseName}: ${diffs.join('; ')}.` : `Changed from ${baseName} in the YAML.`}
      </p>
      <div className="form">
        <button type="button" onClick={onUse} disabled={errors > 0 || unchanged}>
          Use this variant
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {errors > 0 && <span className="bad">{errors} error(s) to fix first</span>}
      </div>
    </fieldset>
  );
}
