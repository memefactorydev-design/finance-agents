// The finance store: versioned JSON rows per company with optimistic
// transactions. Two backends — a JSON file (default, single-user, local) and
// Postgres (DATABASE_URL, for hosted deployments). The whole app reads and
// writes through this interface; nothing touches a backend directly.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { FinanceError, invariant } from "./domain";

export type Row<T = unknown> = { companyId: string; key: string; version: number; data: T };
export type Change = { key: string; expected: number | null; data: unknown };
export interface Store {
  get<T>(companyId: string, key: string): Promise<Row<T> | null>;
  list<T>(companyId: string, prefix: string, cursor?: string, limit?: number): Promise<{ rows: Row<T>[]; cursor?: string }>;
  transact(companyId: string, changes: Change[]): Promise<void>;
}
export class Conflict extends FinanceError {
  constructor() { super("VERSION_CONFLICT", true, 409); }
}
export async function all<T>(store: Store, company: string, prefix: string) {
  const rows: Row<T>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list<T>(company, prefix, cursor, 500);
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}
export async function createOnce<T>(store: Store, c: string, key: string, data: T): Promise<Row<T>> {
  const old = await store.get<T>(c, key);
  if (old) return old;
  try { await store.transact(c, [{ key, expected: null, data }]); }
  catch (e) { if (!(e instanceof Conflict)) throw e; }
  const row = await store.get<T>(c, key);
  invariant(row, "PERSISTENCE_MISSING");
  return row;
}
// Upsert helper: read, patch, write with the row's version (one retry on conflict).
export async function upsert<T>(store: Store, c: string, key: string, patch: (current: T | null) => T): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await store.get<T>(c, key);
    const next = patch(row?.data ?? null);
    try { await store.transact(c, [{ key, expected: row?.version ?? null, data: next }]); return next; }
    catch (e) { if (!(e instanceof Conflict) || attempt === 1) throw e; }
  }
  throw new Conflict();
}

// ------------------------------------------------------------- file store
// Atomic snapshot (write temp + rename) behind an OS-level directory lock.
export class FileStore implements Store {
  constructor(readonly path: string) {}
  private async read(): Promise<Record<string, Row>> {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  }
  private key(c: string, k: string) { return JSON.stringify([c, k]); }
  async get<T>(c: string, k: string) { return ((await this.read())[this.key(c, k)] as Row<T>) ?? null; }
  async list<T>(c: string, prefix: string, cursor?: string, limit = 100) {
    const rows = Object.values(await this.read())
      .filter((r) => r.companyId === c && r.key.startsWith(prefix) && (!cursor || r.key > cursor))
      .sort((a, b) => a.key.localeCompare(b.key));
    const page = rows.slice(0, limit) as Row<T>[];
    return { rows: page, ...(rows.length > limit ? { cursor: page.at(-1)!.key } : {}) };
  }
  async transact(c: string, changes: Change[]) {
    invariant(changes.length > 0 && new Set(changes.map((x) => x.key)).size === changes.length, "INVALID_TRANSACTION");
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    let locked = false;
    for (let i = 0; i < 50 && !locked; i++) {
      try { await mkdir(lock); locked = true; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
      }
    }
    if (!locked) throw new Conflict();
    try {
      const rows = await this.read();
      for (const ch of changes) {
        const old = rows[this.key(c, ch.key)];
        if ((old?.version ?? null) !== ch.expected) throw new Conflict();
      }
      for (const ch of changes) rows[this.key(c, ch.key)] = { companyId: c, key: ch.key, version: (ch.expected ?? 0) + 1, data: ch.data };
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(rows), { mode: 0o600 });
      await rename(tmp, this.path);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

// --------------------------------------------------------- postgres store
// One table: finance_rows(company_id, key, version, data jsonb). Created on
// first use. Optimistic concurrency per row inside one transaction.
export class PostgresStore implements Store {
  private ready: Promise<void> | null = null;
  constructor(readonly connectionString: string) {}
  private async pool() {
    const { Pool } = await import("pg");
    const g = globalThis as unknown as { __financePool?: InstanceType<typeof Pool> };
    g.__financePool ??= new Pool({ connectionString: this.connectionString, max: 4, ssl: /sslmode=require|supabase|neon|rds\.amazonaws/.test(this.connectionString) ? { rejectUnauthorized: false } : undefined });
    const pool = g.__financePool;
    this.ready ??= pool.query(`CREATE TABLE IF NOT EXISTS finance_rows (company_id text NOT NULL, key text NOT NULL, version integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY (company_id, key))`).then(() => undefined);
    await this.ready;
    return pool;
  }
  async get<T>(c: string, k: string) {
    const r = await (await this.pool()).query("SELECT version, data FROM finance_rows WHERE company_id=$1 AND key=$2", [c, k]);
    return r.rows[0] ? ({ companyId: c, key: k, version: r.rows[0].version, data: r.rows[0].data } as Row<T>) : null;
  }
  async list<T>(c: string, prefix: string, cursor?: string, limit = 100) {
    const r = await (await this.pool()).query(
      "SELECT key, version, data FROM finance_rows WHERE company_id=$1 AND key LIKE $2 AND ($3::text IS NULL OR key > $3) ORDER BY key LIMIT $4",
      [c, prefix.replace(/[%_\\]/g, (m) => `\\${m}`) + "%", cursor ?? null, limit + 1],
    );
    const rows = r.rows.map((x) => ({ companyId: c, key: x.key, version: x.version, data: x.data } as Row<T>));
    const page = rows.slice(0, limit);
    return { rows: page, ...(rows.length > limit ? { cursor: page.at(-1)!.key } : {}) };
  }
  async transact(c: string, changes: Change[]) {
    invariant(changes.length > 0 && new Set(changes.map((x) => x.key)).size === changes.length, "INVALID_TRANSACTION");
    const client = await (await this.pool()).connect();
    try {
      await client.query("BEGIN");
      for (const ch of changes) {
        const cur = await client.query("SELECT version FROM finance_rows WHERE company_id=$1 AND key=$2 FOR UPDATE", [c, ch.key]);
        const version = cur.rows[0]?.version ?? null;
        if (version !== ch.expected) { await client.query("ROLLBACK"); throw new Conflict(); }
        if (version === null) await client.query("INSERT INTO finance_rows (company_id, key, version, data) VALUES ($1,$2,1,$3)", [c, ch.key, JSON.stringify(ch.data)]);
        else await client.query("UPDATE finance_rows SET version=$3, data=$4 WHERE company_id=$1 AND key=$2", [c, ch.key, version + 1, JSON.stringify(ch.data)]);
      }
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    } finally { client.release(); }
  }
}

// ------------------------------------------------------------ in-memory
export class MemoryStore implements Store {
  rows = new Map<string, Row>();
  private key(c: string, k: string) { return `${c}\u0000${k}`; }
  async get<T>(c: string, k: string) { return (this.rows.get(this.key(c, k)) as Row<T>) ?? null; }
  async list<T>(c: string, prefix: string, cursor?: string, limit = 100) {
    const rows = [...this.rows.values()].filter((r) => r.companyId === c && r.key.startsWith(prefix) && (!cursor || r.key > cursor)).sort((a, b) => a.key.localeCompare(b.key));
    const page = rows.slice(0, limit) as Row<T>[];
    return { rows: page, ...(rows.length > limit ? { cursor: page.at(-1)!.key } : {}) };
  }
  async transact(c: string, changes: Change[]) {
    for (const ch of changes) { const old = this.rows.get(this.key(c, ch.key)); if ((old?.version ?? null) !== ch.expected) throw new Conflict(); }
    for (const ch of changes) this.rows.set(this.key(c, ch.key), { companyId: c, key: ch.key, version: (ch.expected ?? 0) + 1, data: ch.data });
  }
}

// Lease: a short exclusive lock held in the store (token refresh, callbacks).
export async function lease(store: Store, c: string, name: string, owner: string, now: number, ttlMs: number): Promise<() => Promise<void>> {
  const key = `LEASE#${name}`;
  const row = await store.get<{ owner: string; until: number }>(c, key);
  if (row && row.data.until > now && row.data.owner !== owner) throw new FinanceError("LEASE_BUSY", true, 503);
  await store.transact(c, [{ key, expected: row?.version ?? null, data: { owner, until: now + ttlMs } }]);
  return async () => {
    const cur = await store.get<{ owner: string; until: number }>(c, key);
    if (cur?.data.owner === owner) await store.transact(c, [{ key, expected: cur.version, data: { owner: "", until: 0 } }]).catch(() => {});
  };
}
