// About (apps/web/src/about/About.tsx): the attribution it shows is packs/srd-5.2.1/ATTRIBUTION.md
// word for word, including the M3 modifications line and the Foundry dnd5e credit (m3.md 4.8).
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION } from '../src/content/bundled.ts';

const file = readFileSync(new URL('../../../packs/srd-5.2.1/ATTRIBUTION.md', import.meta.url), 'utf8');
const unescape = (h: string) => h.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('About attribution', () => {
  it('bundles ATTRIBUTION.md byte for byte', () => {
    expect(ATTRIBUTION).toBe(file);
  });
  it('covers the SRD 5.2.1 import and the Foundry dnd5e credit', () => {
    expect(file).toContain('System Reference Document 5.2.1');
    expect(file).toContain('Foundry VTT dnd5e');
    expect(file).toContain('classes, spells, monsters and equipment');
  });
  it('renders the statement verbatim in a pre', async () => {
    // A computed specifier: the test tsconfig has no JSX, so tsc mustn't follow it into the .tsx.
    const about = '../src/about/About' + '.tsx';
    const { About } = (await import(/* @vite-ignore */ about)) as { About: () => null };
    const html = renderToStaticMarkup(createElement(About));
    const pre = /<pre class="attr">([\s\S]*?)<\/pre>/.exec(html);
    expect(pre).not.toBeNull();
    expect(unescape(pre![1]!)).toBe(file);
  });
});
