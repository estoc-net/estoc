/**
 * A process that opens the runtime at `argv[2]`, commits two objects
 * and two events through `SqliteVault`, and kills itself with SIGKILL
 * right after the statement numbered `argv[3]` — counted from the
 * first statement of the commit, after the open — as the crash a
 * commit can meet at any point. With `0` it never dies, and prints how
 * many statements the commit ran. Bundled by `vault.test.ts` and run
 * as many times as there are statements.
 */

import { openNodeSqlite } from "../../../src/node.js";
import { Connection, SqliteVault, openRuntime, rawCidFromDigest, type Cid, type RawConnection } from "../../../src/v3/index.js";
import { ANCHOR } from "../fixtures.js";
import { sha256 } from "@noble/hashes/sha2";

const [file, killAtText] = process.argv.slice(2) as [string, string];
const killAt = Number(killAtText);
let counting = false;
let statements = 0;
const step = (): void => {
  if (!counting) return;
  statements += 1;
  if (statements === killAt) process.kill(process.pid, "SIGKILL");
};

const inner = openNodeSqlite(file, { mode: "readwrite" });
const raw: RawConnection = {
  version: inner.version,
  exec: (sql) => {
    inner.exec(sql);
    step();
  },
  prepare: (sql) => {
    const statement = inner.prepare(sql);
    return {
      run: (params) => {
        const changes = statement.run(...params).changes;
        step();
        return changes;
      },
      rows: (params) => {
        const rows = statement.iterate(...params);
        step();
        return rows;
      },
      finalize: () => statement.finalize(),
    };
  },
  close: () => inner.close(),
};

function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

const vault = new SqliteVault(await openRuntime(new Connection(raw, "readwrite"), { anchor: ANCHOR }));
counting = true;
const world = new TextEncoder().encode("world");
const big = bytesOf(1024 * 1024 + 9, 77);
const cidOf = (bytes: Uint8Array): Cid => rawCidFromDigest(sha256(bytes)).text as Cid;
await vault.vault.commit(
  [
    { cid: cidOf(world), source: world },
    { cid: cidOf(big), source: big },
  ],
  [
    { type: "test.event", roots: [cidOf(world), cidOf(big)], data: { i: 0 } },
    { type: "test.event", roots: [cidOf(big)], data: { i: 1 } },
  ]
);
counting = false;
await vault.close();
process.stdout.write(String(statements));
