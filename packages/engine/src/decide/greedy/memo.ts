// A small per-decision memo of cover degrees (M9 fallback (1), docs/design/coverage.md; 8'a
// review G2). Open addressing with linear probing, keyed by an int `key` plus an int `aux`
// that must match too, generation-stamped so a new decision clears it in O(1). Its size follows
// the entries one decision stores (it doubles past half full), not units x units x cells, so a
// decider built per seat per fight allocates kilobytes even at the schema's limits. Pure and
// deterministic: a lookup returns exactly what was stored, so it never changes a decision.

export class CoverMemo {
  private bits = 8;
  private stamp = new Int32Array(1 << 8);
  private keys = new Int32Array(1 << 8);
  private aux = new Int32Array(1 << 8);
  private vals = new Int8Array(1 << 8);
  private gen = 1;
  private n = 0;

  /** Forgets everything (a new decision). */
  clear(): void {
    this.gen++;
    this.n = 0;
  }

  /** Bytes held (for tests and perf notes). */
  get bytes(): number {
    return this.stamp.byteLength + this.keys.byteLength + this.aux.byteLength + this.vals.byteLength;
  }

  private slot(key: number, aux: number): number {
    return (Math.imul(key ^ Math.imul(aux, 0x27d4eb2f), 0x9e3779b1) >>> 0) >>> (32 - this.bits);
  }

  /** The stored value, or -1. */
  get(key: number, aux: number): number {
    const m = (1 << this.bits) - 1;
    for (let i = this.slot(key, aux); this.stamp[i] === this.gen; i = (i + 1) & m) {
      if (this.keys[i] === key && this.aux[i] === aux) return this.vals[i]!;
    }
    return -1;
  }

  set(key: number, aux: number, v: number): void {
    if (2 * (this.n + 1) > 1 << this.bits) this.grow();
    const m = (1 << this.bits) - 1;
    let i = this.slot(key, aux);
    while (this.stamp[i] === this.gen) {
      if (this.keys[i] === key && this.aux[i] === aux) {
        this.vals[i] = v;
        return;
      }
      i = (i + 1) & m;
    }
    this.stamp[i] = this.gen;
    this.keys[i] = key;
    this.aux[i] = aux;
    this.vals[i] = v;
    this.n++;
  }

  private grow(): void {
    const { stamp, keys, aux, vals, gen } = this;
    this.bits++;
    const size = 1 << this.bits;
    this.stamp = new Int32Array(size);
    this.keys = new Int32Array(size);
    this.aux = new Int32Array(size);
    this.vals = new Int8Array(size);
    this.gen = 1;
    this.n = 0;
    for (let i = 0; i < stamp.length; i++) if (stamp[i] === gen) this.set(keys[i]!, aux[i]!, vals[i]!);
  }
}
