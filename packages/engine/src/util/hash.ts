// Non-cryptographic hashes for identity checks (content, scenario, log, seat keys).
// Not a security boundary: they only have to make accidental collisions unlikely.

/** 32-bit FNV-1a over the UTF-16 code units of a string. Used for stream seat words. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Incremental 64-bit hash: two independent 32-bit lanes, printed as 16 hex digits. */
export class Hash64 {
  private a = 0x811c9dc5;
  private b = 0x9e3779b9;

  update(text: string): this {
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 15;
    }
    this.a = a >>> 0;
    this.b = b >>> 0;
    return this;
  }

  hex(): string {
    // Final avalanche so short inputs still spread across all 64 bits.
    let a = this.a;
    let b = this.b;
    a ^= a >>> 16;
    a = Math.imul(a, 0x85ebca6b);
    a ^= Math.imul(b, 0xc2b2ae35) >>> 13;
    b ^= b >>> 13;
    b = Math.imul(b, 0xc2b2ae35);
    b ^= a >>> 16;
    return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0'));
  }
}

export function hash64(text: string): string {
  return new Hash64().update(text).hex();
}
