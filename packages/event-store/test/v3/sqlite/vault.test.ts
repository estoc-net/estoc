/**
 * The SQLite vault over `node:sqlite`: the vault conformance suite in
 * memory and on files, the vault cases, and what only a process on a
 * file can show — a commit killed at every one of its statements.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import { SqliteVault, createRuntime, openRuntime, type AuthorId, type Cid, type OpenMode, type RuntimeDatabase, type SqliteDriver, type SqlValue } from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { all } from "../suite/helpers.js";
import { HELLO_CID, cidOf } from "../suite/object-store-suite.js";
import { vaultSuite, type VaultUnderTest } from "../suite/vault-suite.js";
import { vaultCases } from "./vault-cases.js";

const HELLO = new TextEncoder().encode("hello");

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-vault-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (target: string, mode: OpenMode): SqliteDriver => openNodeSqlite(target, { mode });

function rows(driver: SqliteDriver, sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

function exec(driver: SqliteDriver, sql: string, ...params: SqlValue[]): void {
  const statement = driver.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

/** `db` as the runtime of `author`: the control row rewritten, as a test names its replicas. */
function authoredAs(db: RuntimeDatabase, author: AuthorId): RuntimeDatabase {
  exec(db.driver, "UPDATE store_state SET replica_id = ?", author);
  return { driver: db.driver, metadata: db.metadata, author, generation: db.generation, writable: db.writable, keystore: (locked) => db.keystore(locked), close: () => db.close() };
}

/** Flips one byte of the first chunk of `cid`, as a bad sector would. */
function corrupt(driver: SqliteDriver, cid: Cid): void {
  const [row] = rows(driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = 0", cid);
  if (row === undefined) throw new Error(`${cid} has no bytes to damage`);
  const bytes = new Uint8Array(row["bytes"] as Uint8Array);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  exec(driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = 0", bytes, cid);
}

function opener(target: () => string) {
  return async ({ author, now }: { author: AuthorId; now: () => number }): Promise<VaultUnderTest> => {
    const db = authoredAs(createRuntime(open(target(), "create"), { metadata: META, wrapped: WRAPPED }), author);
    const vault = new SqliteVault(db, { now });
    return { vault, corrupt: async (cid) => corrupt(db.driver, cid) };
  };
}

vaultSuite("SqliteVault in memory", opener(() => ":memory:"));
vaultSuite("SqliteVault on a file", opener(fresh));

describe("the vault cases on node:sqlite files", () => {
  for (const c of vaultCases) {
    it(c.name, async () => {
      const note = await c.run({ fresh, open: async (target, mode) => open(target, mode) });
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("a commit across a crash", () => {
  /** A vault at a fresh file holding one commit, closed. */
  async function seeded(): Promise<string> {
    const file = fresh();
    const vault = new SqliteVault(createRuntime(open(file, "create"), { metadata: META, wrapped: WRAPPED }));
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [{ type: "test.event", roots: [HELLO_CID], data: {} }]);
    await vault.close();
    return file;
  }

  async function commitInAnotherProcess(bundle: string, file: string, killAt: number): Promise<{ signal: NodeJS.Signals | null; output: string }> {
    const child = spawn(process.execPath, ["--no-warnings", bundle, file, String(killAt)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done, reject) => {
      child.on("error", reject);
      child.on("exit", (c, s) => done([c, s]));
    });
    if (signal === null && code !== 0) throw new Error(`the other process (killed at ${killAt}) exited with ${code}: ${output}`);
    return { signal, output };
  }

  /** The reopened file holds the seed commit, and the batch whole or not at all: every root of every event present and readable, no damage, valid control. */
  async function wholeOrNone(file: string, what: string): Promise<number> {
    const vault = new SqliteVault(await openRuntime(open(file, "readwrite"), { anchor: ANCHOR }));
    try {
      const events = await all(vault.vault.events.scan());
      expect([1, 3], `${what}: ${events.length} events`).toContain(events.length);
      for (const event of events) {
        for (const root of event.roots) {
          const bytes = await vault.vault.objects.read(root, 2 * 1024 * 1024);
          expect(bytes, `${what}: root ${root}`).not.toBeNull();
          expect(cidOf(bytes as Uint8Array), `${what}: root ${root} reads back as itself`).toBe(root);
        }
      }
      expect(await all(vault.vault.objects.list()), what).toHaveLength(events.length === 1 ? 1 : 3);
      expect(await vault.vault.events.damaged(), what).toEqual([]);
      expect(vault.stopped, what).toBeUndefined();
      return events.length;
    } finally {
      await vault.close();
    }
  }

  it("killed right after any statement of the commit, the process leaves the batch whole or not at all; never killed, it leaves it whole", async () => {
    const bundle = path.join(dir, "commit-child.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./commit-child.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      mainFields: ["module", "main"],
      outfile: bundle,
    });
    const whole = await seeded();
    const counted = await commitInAnotherProcess(bundle, whole, 0);
    expect(counted.signal).toBeNull();
    const statements = Number(counted.output);
    expect(statements).toBeGreaterThan(10);
    expect(await wholeOrNone(whole, "never killed")).toBe(3);
    const points = statements <= 60 ? Array.from({ length: statements }, (_, i) => i + 1) : Array.from({ length: 40 }, (_, i) => Math.max(1, Math.round(((i + 1) * statements) / 40)));
    const outcomes: number[] = [];
    for (const killAt of points) {
      const file = await seeded();
      const { signal } = await commitInAnotherProcess(bundle, file, killAt);
      expect(signal, `killed at ${killAt}`).toBe("SIGKILL");
      outcomes.push(await wholeOrNone(file, `killed at ${killAt}`));
    }
    // the kill points cover both outcomes: up to the COMMIT nothing landed, from it on everything did
    expect(outcomes[0]).toBe(1);
    expect(outcomes[outcomes.length - 1]).toBe(3);
    expect(new Set(outcomes)).toEqual(new Set([1, 3]));
  }, 120_000);
});
