// About: what this is, and the attribution, verbatim (CC-BY-4.0 requires it): packs/srd-5.2.1/
// ATTRIBUTION.md word for word, which since M3 covers the imported SRD 5.2.1 classes, spells,
// monsters and equipment and credits the Foundry dnd5e data they came through (m3.md 4.8).

import { ENGINE_VERSION } from '@montecrit/engine';
import { ATTRIBUTION } from '../content/bundled.ts';

export function About() {
  return (
    <>
      <h2>MonteCrit</h2>
      <p className="note">
        A combat simulator for 5e (SRD 5.2.1): seeded Monte Carlo fights on a 5-ft grid. Engine {ENGINE_VERSION}. Everything runs in your browser; nothing you load or build is sent anywhere.
      </p>
      <p className="note">
        MonteCrit by Shane Cerutti. Free software under the GNU AGPL v3.0. Source code:{' '}
        <a href="https://github.com/Cerutti13/montecrit" target="_blank" rel="noreferrer">
          github.com/Cerutti13/montecrit
        </a>
        .
      </p>
      <p className="note">MonteCrit is unofficial fan-made software. It is not affiliated with, endorsed, sponsored or approved by Wizards of the Coast.</p>
      <h2>Attribution</h2>
      <p className="note">The bundled SRD 5.2.1 content (stat blocks, classes, species, backgrounds, feats, spells, monsters and equipment) is used under this statement, reproduced from the pack's ATTRIBUTION.md:</p>
      <pre className="attr">{ATTRIBUTION}</pre>
    </>
  );
}
