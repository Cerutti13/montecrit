# MonteCrit

A combat simulator for 5e (SRD 5.2.1). Put a character in a fight, run it ten thousand
times, and see how often it wins, why it loses, and which opening turn actually helps.

**Try it in the browser:** https://cerutti13.github.io/montecrit/ (no install, no account;
fights run in Web Workers on your machine and nothing is sent anywhere).

## What it does

- **Run:** seeded Monte Carlo fights on a 5-ft grid. Win, loss and TPK rates with 95% confidence
  intervals, and paired comparisons between play policies on the same dice (McNemar, Holm).
- **Replay:** step through any exemplar fight (the closest loss, a typical win, a TPK) with the
  cause chain behind every drop and death.
- **Character:** build a character from the SRD classes, species, backgrounds and feats, and see
  every derived number with its source.
- **Odds:** exact (not sampled) chances for every check and save on a sheet.
- **Practice:** play one seat turn by turn against the AI, with a quick encounter builder.
- **Encounter:** "is my fight too strong?" Pick a party and foes, and the app plays it out on
  both sides and tells you how it tends to go.
- **Compare:** two to four builds in the same seat of the same fight, paired run by run.

Every result is reproducible: the same engine version, content, scenario and seed always give
the same fights, in the browser and on the command line.

## Command line

Node 26.9 runs the TypeScript directly; there is no build step.

```bash
npm install
npm test
npx montecrit run stars-ambush -n 2000 --policy greedy,moonbeam-first,spike-first
npx montecrit run stars-ambush -n 2000 --policy greedy --replay closest-loss
npx montecrit odds --mod 5 --guidance --dc 15
npm run web        # the browser app on http://127.0.0.1:5180
```

Your own content (characters, packs, scenarios, policies) can live in `~/.montecrit/`. The local
dev server (`npm run web`) loads it into the page; the public site never sees it.

## What it doesn't do yet

- Only SRD 5.2.1 content ships. Subclasses, species and spells outside the SRD aren't included.
- Some features are partial (for example, monsters can't Hide yet). Every report lists what it
  didn't model for the creatures in that fight.
- Ambiguous rules are named flags with a "verified" bit, and every report prints the flags it used.
  If you think a ruling is wrong, open an issue with the page cite.

Bug reports, wrong rulings and feature requests are all welcome as GitHub issues. Pull requests
need the contributor terms in `CONTRIBUTING.md`.

## License

Code: GNU Affero General Public License v3.0 only (`LICENSE`), with one additional term under
section 7(b): keep the "MonteCrit by Shane Cerutti" credit and a link to this repository in the
About screen of any version you share or host (`COPYRIGHT`). If you run a modified version for
other people over a network, you must offer them its source. For other licensing terms, open an
issue.

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of
the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the
Creative Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode. The full attribution, including the Foundry
dnd5e data the SRD content was converted through, is in `packs/srd-5.2.1/ATTRIBUTION.md`.

MonteCrit is unofficial fan-made software. It is not affiliated with, endorsed, sponsored or
approved by Wizards of the Coast.
