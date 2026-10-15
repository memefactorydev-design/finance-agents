// Content-addressed evidence custody for PDFs and email bodies. Bytes live on
// disk (./data/evidence/<sha256>) or in Postgres (finance_blobs); the store
// rows only ever hold the sha256 and size, never the bytes.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesHash, FinanceError, invariant } from "./domain";

export interface EvidenceRef { id: string; sha256: string; locator: string }
export interface EvidenceAdapter {
  put(company: string, bytes: Uint8Array, contentType: string): Promise<EvidenceRef>;
  read(company: string, id: string): Promise<Uint8Array>;
}

export class FileEvidence implements EvidenceAdapter {
  constructor(readonly root: string) {}
  async put(c: string, bytes: Uint8Array, _contentType: string) {
    const sha256 = bytesHash(bytes);
    const dir = join(this.root, encodeURIComponent(c));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, sha256), bytes, { mode: 0o600 });
    const id = `evidence/${encodeURIComponent(c)}/${sha256}`;
    return { id, sha256, locator: id };
  }
  async read(c: string, id: string) {
    const parts = id.split("/");
    invariant(parts.length === 3 && parts[0] === "evidence" && parts[1] === encodeURIComponent(c) && /^[a-f0-9]{64}$/.test(parts[2]), "EVIDENCE_SCOPE_DENIED");
    let bytes: Buffer;
    try { bytes = await readFile(join(this.root, parts[1], parts[2])); }
    catch { throw new FinanceError("EVIDENCE_MISSING", true, 503); }
    invariant(bytesHash(bytes) === parts[2], "EVIDENCE_HASH_MISMATCH");
    return new Uint8Array(bytes);
  }
}

export class PostgresEvidence implements EvidenceAdapter {
  private ready: Promise<void> | null = null;
  constructor(readonly connectionString: string) {}
  private async pool() {
    const { Pool } = await import("pg");
    const g = globalThis as unknown as { __financeBlobPool?: InstanceType<typeof Pool> };
    g.__financeBlobPool ??= new Pool({ connectionString: this.connectionString, max: 2, ssl: /sslmode=require|supabase|neon|rds\.amazonaws/.test(this.connectionString) ? { rejectUnauthorized: false } : undefined });
    const pool = g.__financeBlobPool;
    this.ready ??= pool.query(`CREATE TABLE IF NOT EXISTS finance_blobs (company_id text NOT NULL, sha256 text NOT NULL, content_type text NOT NULL, bytes bytea NOT NULL, PRIMARY KEY (company_id, sha256))`).then(() => undefined);
    await this.ready;
    return pool;
  }
  async put(c: string, bytes: Uint8Array, contentType: string) {
    const sha256 = bytesHash(bytes);
    await (await this.pool()).query("INSERT INTO finance_blobs (company_id, sha256, content_type, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [c, sha256, contentType, Buffer.from(bytes)]);
    const id = `evidence/${encodeURIComponent(c)}/${sha256}`;
    return { id, sha256, locator: id };
  }
  async read(c: string, id: string) {
    const parts = id.split("/");
    invariant(parts.length === 3 && parts[0] === "evidence" && parts[1] === encodeURIComponent(c), "EVIDENCE_SCOPE_DENIED");
    const r = await (await this.pool()).query("SELECT bytes FROM finance_blobs WHERE company_id=$1 AND sha256=$2", [c, parts[2]]);
    if (!r.rows[0]) throw new FinanceError("EVIDENCE_MISSING", true, 503);
    const bytes = new Uint8Array(r.rows[0].bytes);
    invariant(bytesHash(bytes) === parts[2], "EVIDENCE_HASH_MISMATCH");
    return bytes;
  }
}
