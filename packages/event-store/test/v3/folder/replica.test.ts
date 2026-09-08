import { describe, expect, it } from "vitest";

import {
  DamagedReplica,
  MemoryBackend,
  encodeReplica,
  isUuidv7,
  mintReplica,
  openReplica,
  parseReplica,
  readReplica,
  text,
  utf8,
  type Replica,
} from "../../../src/v3/index.js";
import { authorN } from "../suite/helpers.js";

const R: Replica = { replica_id: authorN(1), store_generation: "019b2a43-5c8d-75a0-bf82-b2a61a4ce099" };

describe("local/replica.json", () => {
  it("mints two canonical UUIDv7s, distinct each time", () => {
    const a = mintReplica();
    const b = mintReplica();
    expect(isUuidv7(a.replica_id)).toBe(true);
    expect(isUuidv7(a.store_generation)).toBe(true);
    expect(a.replica_id).not.toBe(a.store_generation);
    expect(a.replica_id).not.toBe(b.replica_id);
    expect(a.store_generation).not.toBe(b.store_generation);
  });

  it("writes the file pretty-printed with LF, the two members in order, and reads it back", () => {
    const bytes = encodeReplica(R);
    expect(text(bytes)).toBe(`{\n  "replica_id": "${R.replica_id}",\n  "store_generation": "${R.store_generation}"\n}\n`);
    expect(parseReplica(bytes)).toEqual(R);
    // any spelling of the same JSON reads the same: the file is JSON, not canonical bytes
    expect(parseReplica(utf8(JSON.stringify({ store_generation: R.store_generation, replica_id: R.replica_id })))).toEqual(R);
  });

  it("a partial, malformed or inconsistent file is DamagedReplica, never repaired by keeping the half that parses", () => {
    const damaged: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ["half-written", utf8(`{\n  "replica_id": "${R.replica_id}",\n  "store_gen`)],
      ["not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
      ["an array", utf8("[]")],
      ["a string", utf8('"x"')],
      ["null", utf8("null")],
      ["only replica_id", utf8(JSON.stringify({ replica_id: R.replica_id }))],
      ["only store_generation", utf8(JSON.stringify({ store_generation: R.store_generation }))],
      ["an extra member", utf8(JSON.stringify({ ...R, device: "laptop" }))],
      ["a duplicate member", utf8(`{"replica_id":"${R.replica_id}","replica_id":"${R.replica_id}","store_generation":"${R.store_generation}"}`)],
      ["replica_id uppercase", utf8(JSON.stringify({ ...R, replica_id: R.replica_id.toUpperCase() }))],
      ["replica_id version 4", utf8(JSON.stringify({ ...R, replica_id: R.replica_id.replace("-7", "-4") }))],
      ["replica_id not a string", utf8(JSON.stringify({ ...R, replica_id: 1 }))],
      ["store_generation null", utf8(JSON.stringify({ ...R, store_generation: null }))],
      ["store_generation not a UUID", utf8(JSON.stringify({ ...R, store_generation: "gen-1" }))],
    ];
    for (const [name, bytes] of damaged) {
      let err: unknown;
      try {
        parseReplica(bytes, "local/replica.json");
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(DamagedReplica);
      expect((err as DamagedReplica).path, name).toBe("local/replica.json");
      expect((err as Error).message, name).toMatch(/^local\/replica\.json: /);
    }
  });

  it("readReplica: null when the whole file is absent, the replica when whole, a throw when damaged", async () => {
    const backend = new MemoryBackend();
    expect(await readReplica(backend, ".estoc")).toBeNull();
    await backend.write(".estoc/local/replica.json", encodeReplica(R));
    expect(await readReplica(backend, ".estoc")).toEqual(R);
    await backend.write(".estoc/local/replica.json", utf8("{"));
    await expect(readReplica(backend, ".estoc")).rejects.toBeInstanceOf(DamagedReplica);
    await expect(readReplica(backend, ".estoc")).rejects.toThrow(".estoc/local/replica.json");
  });

  it("openReplica mints and durably writes the file when absent, returns the file's when present, and appends no event", async () => {
    const backend = new MemoryBackend();
    const minted = await openReplica(backend, ".estoc");
    expect(isUuidv7(minted.replica_id)).toBe(true);
    expect(parseReplica((await backend.read(".estoc/local/replica.json")) as Uint8Array)).toEqual(minted);
    expect(await openReplica(backend, ".estoc")).toEqual(minted); // the same on a later open
    expect(await backend.dirs(".estoc")).toEqual(["local"]); // no events/, nothing appended
    // a damaged file blocks the open rather than being replaced
    await backend.write(".estoc/local/replica.json", utf8(JSON.stringify({ replica_id: minted.replica_id })));
    await expect(openReplica(backend, ".estoc")).rejects.toBeInstanceOf(DamagedReplica);
    expect(text((await backend.read(".estoc/local/replica.json")) as Uint8Array)).toBe(JSON.stringify({ replica_id: minted.replica_id })); // untouched
    // the generator is injectable: a test names its author
    const fresh = new MemoryBackend();
    expect(await openReplica(fresh, "v", () => R)).toEqual(R);
    expect(await readReplica(fresh, "v")).toEqual(R);
  });
});
