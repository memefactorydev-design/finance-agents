// AES-256-GCM under a key derived from APP_SECRET. Used for every stored
// secret (QuickBooks tokens, mailbox and CRM credentials). The ciphertext is
// bound to the company id as additional authenticated data.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { invariant } from "./domain";

export interface Cipher {
  encrypt(company: string, text: string): Promise<string>;
  decrypt(company: string, ciphertext: string): Promise<string>;
}
export class AesGcmCipher implements Cipher {
  constructor(readonly key: Buffer) { invariant(key.length === 32, "INVALID_CIPHER_KEY"); }
  async encrypt(c: string, text: string) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(c));
    return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  async decrypt(c: string, text: string) {
    const bytes = Buffer.from(text, "base64"), d = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    d.setAAD(Buffer.from(c));
    d.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([d.update(bytes.subarray(12, -16)), d.final()]).toString();
  }
}

export function appSecret(): string {
  const s = (process.env.APP_SECRET || "").trim();
  invariant(s.length >= 32, "MISSING_APP_SECRET");
  return s;
}
export function appSecretPresent(): boolean { return (process.env.APP_SECRET || "").trim().length >= 32; }
export function appCipher(): Cipher {
  return new AesGcmCipher(createHash("sha256").update(`finance-agents:cipher:${appSecret()}`).digest());
}

// Password hashing (scrypt) for the owner login.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const key = scryptSync(password, Buffer.from(saltB64, "base64"), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyB64, "base64");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
