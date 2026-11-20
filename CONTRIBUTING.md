# Contributing

Issues are the most useful thing you can send: bugs, rules the sim gets wrong (with a page
cite from SRD 5.2.1 if you have one), and questions you'd want it to answer.

## Pull requests

MonteCrit is licensed under AGPL-3.0-only. The author also intends to offer it under other
terms (for example, a commercial license or a closed-source companion module), so contributions
need a license that allows that.

By opening a pull request, you agree that:

1. Your contribution is your own work, or you have the right to submit it.
2. You license it to the project under AGPL-3.0-only, and you also grant Shane Cerutti a
   perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify,
   sublicense and relicense it under any terms, including proprietary ones.
3. You keep the copyright in your contribution.

Please add this line to the pull request description:

> I agree to the contributor terms in CONTRIBUTING.md.

Pull requests without it can't be merged.

## Before you send one

```bash
npm install
npm run lint
npm test
```

The engine is deterministic: no `Math.random`, dates or timers in `packages/engine/src`, and
the lint enforces it. Only SRD 5.2.1 content can be committed; `tools/check-private.ts` refuses
known non-SRD names.
