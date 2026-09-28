import {sha256} from '@noble/hashes/sha2.js';

// The encodings the sealed formats share with twoody-desktop's
// src/shared/vault.ts and twoody-app's utils/vault.js, byte for byte:
// hex, the canonical header (label, then each field prefixed by its length
// on two bytes) and the fingerprint of a pair of public keys. Kept equal
// to them; the compute vectors check it (test/computeSeal.test.ts).

export class SealError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const encoder = new TextEncoder();
const utf8 = (value: unknown): Uint8Array => encoder.encode(String(value));
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) throw new SealError('bad_hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function canonicalHeader(label: string, fields: unknown[]): Uint8Array {
  const parts: Uint8Array[] = [utf8(label)];
  for (const value of fields) {
    const bytes = utf8(value ?? '');
    parts.push(new Uint8Array([bytes.length >> 8, bytes.length & 255]), bytes);
  }
  return concat(...parts);
}

export function fingerprint(encPublic: Uint8Array, signPublic: Uint8Array): string {
  return (toHex(sha256(concat(utf8('twoody/vault/fp/v1'), encPublic, signPublic)).slice(0, 10)).match(/.{4}/g) as string[]).join('-');
}
