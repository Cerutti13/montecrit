// Canonical JSON: object keys sorted with < (never locale order), undefined members
// dropped, typed arrays written as plain arrays. Two values that mean the same thing
// serialize to the same string, so hashes over them are stable across key order.

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`canonicalJson: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return canonicalJson(Array.from(value as unknown as ArrayLike<number>));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: can't serialize a ${typeof value}`);
}
