// An in-thread Transport for scheduler tests: a real worker core, messages structured-cloned
// both ways (as a Worker would), and each reply delivered after a seeded number of microtask
// hops, so replies from different workers arrive in a shuffled order. No timers.
import { createWorkerCore, type FromWorker, type ToWorker, type Transport } from '../../src/index.ts';

export interface TestTransport extends Transport {
  /** Simulates the worker dying. */
  crash(why: string): void;
  readonly sent: ToWorker[];
  readonly closed: () => boolean;
}

export interface TestOptions {
  /** Shuffle seed; 0 delivers every reply on the next microtask. */
  /** `sync` delivers inside send() (re-entrancy test). */
  readonly sync?: boolean;
  readonly salt?: number;
  readonly maxHops?: number;
  /** Every reply waits exactly this many hops (overrides salt). */
  readonly delay?: number;
  /** Rewrites a reply before delivery; an array delivers several (null drops it). */
  readonly rewrite?: (reply: FromWorker, msg: ToWorker) => FromWorker | FromWorker[] | null;
}

export function testTransport(opts: TestOptions = {}): TestTransport {
  const core = createWorkerCore();
  let s = ((opts.salt ?? 0) * 2654435761) >>> 0;
  // At least one hop: a real worker never answers inside send().
  const hops = () => {
    if (opts.delay !== undefined) return opts.delay;
    if (!opts.salt) return 1;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return 1 + (s % ((opts.maxHops ?? 12) + 1));
  };
  let onMsg: (m: FromWorker) => void = () => {};
  let onFail: (why: string, detail: string | null) => void = () => {};
  let closed = false;
  const sent: ToWorker[] = [];
  return {
    sent,
    closed: () => closed,
    send(msg) {
      if (closed) return;
      sent.push(msg);
      const reply = core(structuredClone(msg));
      const out = opts.rewrite ? opts.rewrite(reply, msg) : reply;
      const list = out === null ? [] : Array.isArray(out) ? out : [out];
      if (opts.sync) {
        for (const r of list) if (!closed) onMsg(structuredClone(r));
        return;
      }
      const d = hops();
      void (async () => {
        for (let i = 0; i < d; i++) await null;
        for (const r of list) if (!closed) onMsg(structuredClone(r));
      })();
    },
    onMessage(cb) {
      onMsg = cb;
    },
    onFailure(cb) {
      onFail = cb;
    },
    crash(why) {
      if (!closed) onFail(why, null);
    },
    close() {
      closed = true;
    },
  };
}
