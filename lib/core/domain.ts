// Shared primitives: typed errors, invariants, canonical hashing, secret
// comparison and the money / date helpers every finance module relies on.
// Dependency-free so anything can import it without cycles.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export class FinanceError extends Error {
  constructor(public code: string, public retryable = false, public status = 422) {
    super(code);
  }
}
export const fail = (code: string): never => { throw new FinanceError(code); };
export function invariant(value: unknown, code: string): asserts value {
  if (!value) fail(code);
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { invariant(Number.isFinite(value), "NON_FINITE"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  invariant(typeof value === "object" && value !== undefined, "UNSERIALISABLE");
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const bytesHash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const sign = (value: unknown, secret: string) => createHmac("sha256", secret).update(canonical(value)).digest("hex");
export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const truthy = (v: string | undefined | null) => /^(1|true|yes|on)$/i.test((v || "").trim());
export const falsy = (v: string | undefined | null) => /^(0|false|no|off)$/i.test((v || "").trim());
export const nowIso = () => new Date().toISOString();
