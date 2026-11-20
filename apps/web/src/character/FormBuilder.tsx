// The pick form (docs/design/m3.md 10, "Web"): selects generated from the loaded class, subclass,
// species, background and feat data (form.ts). Every change rewrites the YAML pane.

import { ABILITIES, type Ability, type CharacterLib } from '@montecrit/engine';
import { LEVELS, formNeeds, formOptions, type AsiPick, type CharacterForm, type PickInput } from './form.ts';
import type { Need } from './lib.ts';

const ABILITY: Readonly<Record<Ability, string>> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
const NO_ASI: AsiPick = { mode: 'two', a: '', b: '', feat: '' };
const label = (o: { readonly id: string; readonly name: string | null }): string => (o.name ? `${o.name} (${o.id})` : o.id);

function ChoicePick({ n, value, onChange }: { n: Need; value: readonly string[]; onChange: (v: string[]) => void }) {
  const slots = Array.from({ length: n.choose }, (_, i) => value[i] ?? '');
  return (
    <fieldset className="pick">
      <legend>
        {n.where}: choose {n.choose} ({n.what}) <span className="mono muted">{n.key}</span>
      </legend>
      {slots.map((v, i) => (
        <select
          key={i}
          aria-label={`${n.key} choice ${i + 1} of ${n.choose}`}
          value={v}
          onChange={(e) => {
            const next = [...slots];
            next[i] = e.target.value;
            onChange(next);
          }}
        >
          <option value="">(not chosen)</option>
          {n.options
            .filter((o) => o.id === v || !slots.includes(o.id))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {label(o)}
              </option>
            ))}
        </select>
      ))}
    </fieldset>
  );
}

function AbilitySelect({ value, among, onChange, name }: { value: string; among: readonly string[]; onChange: (v: string) => void; name: string }) {
  return (
    <select aria-label={name} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">(ability)</option>
      {among.map((a) => (
        <option key={a} value={a}>
          {ABILITY[a as Ability] ?? a}
        </option>
      ))}
    </select>
  );
}

export function AsiPickView({ n, value, onChange }: { n: Need; value: AsiPick; onChange: (v: AsiPick) => void }) {
  const bg = n.kind === 'abilities';
  const among = bg ? n.options.map((o) => o.id) : ABILITIES;
  const set = (p: Partial<AsiPick>) => onChange({ ...value, ...p });
  return (
    <fieldset className="pick">
      <legend>
        {n.where}: {bg ? 'score increases (recorded; the scores above are final)' : 'Ability Score Improvement or a General feat'} <span className="mono muted">{n.key}</span>
      </legend>
      <select aria-label={`${n.key} kind`} value={value.mode} onChange={(e) => set({ mode: e.target.value as AsiPick['mode'] })}>
        <option value="two">{bg ? '+2 and +1' : '+2 to one score'}</option>
        {bg ? <option value="all">+1 to all three</option> : <option value="oneone">+1 to two scores</option>}
        {!bg && <option value="feat">a General feat</option>}
      </select>{' '}
      {value.mode === 'feat' ? (
        <select aria-label={`${n.key} feat`} value={value.feat} onChange={(e) => set({ feat: e.target.value })}>
          <option value="">(feat)</option>
          {n.options.map((o) => (
            <option key={o.id} value={o.id}>
              {label(o)}
            </option>
          ))}
        </select>
      ) : value.mode === 'all' ? (
        <span className="muted">{among.map((a) => ABILITY[a as Ability] ?? a).join(', ')}</span>
      ) : (
        <>
          <AbilitySelect name={`${n.key} ${value.mode === 'two' ? (bg ? '+2' : '+2 ability') : 'first +1'}`} value={value.a} among={among} onChange={(a) => set({ a })} />
          {(value.mode === 'oneone' || bg) && (
            <>
              {' '}
              <AbilitySelect name={`${n.key} ${bg ? '+1' : 'second +1'}`} value={value.b} among={among.filter((a) => a !== value.a)} onChange={(b) => set({ b })} />
            </>
          )}
        </>
      )}
    </fieldset>
  );
}

export function FormBuilder({ lib, form, onChange }: { lib: CharacterLib; form: CharacterForm; onChange: (f: CharacterForm) => void }) {
  const o = formOptions(lib, form);
  const needs = formNeeds(lib, form);
  const set = (p: Partial<CharacterForm>) => onChange({ ...form, ...p });
  const setPick = (key: string, v: PickInput) => onChange({ ...form, picks: { ...form.picks, [key]: v } });
  return (
    <section aria-label="Build from the class data">
      <div className="form">
        <label>
          Id <input value={form.id} onChange={(e) => set({ id: e.target.value })} size={24} />
        </label>
        <label>
          Name <input value={form.name} onChange={(e) => set({ name: e.target.value })} size={20} />
        </label>
        <label>
          Class{' '}
          <select value={form.cls} onChange={(e) => set({ cls: e.target.value, subclass: '', picks: {} })}>
            {o.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Level{' '}
          <select value={form.level} onChange={(e) => set({ level: Number(e.target.value) })}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {o.subclassOpen ? (
          <label>
            Subclass{' '}
            <select value={form.subclass} onChange={(e) => set({ subclass: e.target.value })}>
              <option value="">(not chosen)</option>
              {o.subclasses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="muted">{o.subclassLevel !== null ? `Subclass from level ${o.subclassLevel}` : ''}</span>
        )}
        <label>
          Species{' '}
          <select value={form.species} onChange={(e) => set({ species: e.target.value, size: '' })}>
            {o.species.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {o.sizes.length > 1 && (
          <label>
            Size{' '}
            <select value={form.size} onChange={(e) => set({ size: e.target.value })}>
              <option value="">(not chosen)</option>
              {o.sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Background{' '}
          <select value={form.background} onChange={(e) => set({ background: e.target.value })}>
            {o.backgrounds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          HP{' '}
          <select value={form.hp} onChange={(e) => set({ hp: e.target.value as CharacterForm['hp'] })}>
            <option value="average">average</option>
            <option value="max">max</option>
          </select>
        </label>
      </div>
      <fieldset className="form scores">
        <legend>Final ability scores (increases included)</legend>
        {ABILITIES.map((a) => (
          <label key={a}>
            {ABILITY[a]}{' '}
            <input
              type="number"
              min={1}
              max={30}
              value={form.abilities[a]}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v)) set({ abilities: { ...form.abilities, [a]: v } });
              }}
              size={3}
            />
          </label>
        ))}
      </fieldset>
      {needs.length === 0 ? (
        <p className="muted">This build asks for no picks.</p>
      ) : (
        needs.map((n) => {
          const v = form.picks[n.key];
          if (n.kind === 'choice') return <ChoicePick key={n.key} n={n} value={Array.isArray(v) ? (v as readonly string[]) : []} onChange={(x) => setPick(n.key, x)} />;
          return <AsiPickView key={n.key} n={n} value={v !== undefined && !Array.isArray(v) ? (v as AsiPick) : NO_ASI} onChange={(x) => setPick(n.key, x)} />;
        })
      )}
      <p className="note">Feats picked here may ask for picks of their own, and equipment and spells are left to the YAML pane: the lint below lists what is still missing.</p>
    </section>
  );
}
