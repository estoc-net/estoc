/**
 * The contract every VaultBackend must honour, as cases that run
 * anywhere: vitest wraps them for memory and disk (`backend-suite.ts`),
 * and a page in a real browser runs the same list against OPFS
 * (`../browser/opfs-entry.ts`). No test framework is imported here.
 */

import { walk, type VaultBackend } from "../../src/backend/types.js";

export type Fresh = () => Promise<VaultBackend>;

export interface BackendCase {
  name: string;
  run: (fresh: Fresh) => Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${what}: expected ${e}, got ${a}`);
  }
}

function text(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : dec.decode(bytes);
}

async function rejects(work: Promise<unknown>, pattern: RegExp, what: string): Promise<void> {
  try {
    await work;
  } catch (err) {
    if (pattern.test(err instanceof Error ? err.message : String(err))) {
      return;
    }
    throw new Error(`${what}: rejected with the wrong error: ${String(err)}`);
  }
  throw new Error(`${what}: did not reject`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `n` deterministic bytes from `seed`. */
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

/** `bytes` as a source of chunks of `size` (the last takes the rest). */
async function* chunks(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, Math.min(at + size, bytes.length));
}

/** Everything `stream` yields, as numbers; a stream that is null fails. */
async function drain(stream: ReadableStream<Uint8Array> | null): Promise<number[]> {
  if (stream === null) throw new Error("expected a stream, got null");
  const reader = stream.getReader();
  const out: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    for (const byte of value as Uint8Array) out.push(byte);
  }
}

export const backendCases: BackendCase[] = [
  {
    name: "reads null for a missing file and [] for a missing dir",
    run: async (fresh) => {
      const b = await fresh();
      same(await b.read(".estoc/nope.json"), null, "read");
      same(await b.list(".estoc/devices"), [], "list");
      same(await b.dirs(".estoc/devices"), [], "dirs");
      same(await b.size(".estoc/nope.json"), null, "size");
      same(await b.modified(".estoc/nope.json"), null, "modified");
    },
  },
  {
    name: "writes, reads back, and replaces",
    run: async (fresh) => {
      const b = await fresh();
      await b.write(".estoc/config.json", enc.encode("one"));
      same(text(await b.read(".estoc/config.json")), "one", "first");
      await b.write(".estoc/config.json", enc.encode("two"));
      same(text(await b.read(".estoc/config.json")), "two", "replaced");
    },
  },
  {
    name: "appends, creating the file when missing",
    run: async (fresh) => {
      const b = await fresh();
      await b.append(".estoc/devices/k7q3ma/a.jsonl", enc.encode("a\n"));
      await b.append(".estoc/devices/k7q3ma/a.jsonl", enc.encode("b\n"));
      same(text(await b.read(".estoc/devices/k7q3ma/a.jsonl")), "a\nb\n", "appended");
    },
  },
  {
    name: "lists files and directories separately, and walks the tree",
    run: async (fresh) => {
      const b = await fresh();
      await b.write(".estoc/config.json", enc.encode("{}"));
      await b.write(".estoc/blobs/a", enc.encode("{}"));
      await b.write(".estoc/blobs/b", enc.encode("{}"));
      await b.write(".estoc/blobs/deeper/c", enc.encode("{}"));
      same((await b.list(".estoc/blobs")).sort(), ["a", "b"], "files");
      same(await b.dirs(".estoc/blobs"), ["deeper"], "dirs");
      same(await b.list(".estoc"), ["config.json"], "root files");
      same(await b.dirs(".estoc"), ["blobs"], "root dirs");
      same(await b.dirs(".estoc/nope"), [], "missing dirs");
      same(await walk(b, ".estoc"), [".estoc/blobs/a", ".estoc/blobs/b", ".estoc/blobs/deeper/c", ".estoc/config.json"], "walk");
      same(await walk(b, ".estoc/nope"), [], "walk missing");
    },
  },
  {
    name: "tells a file from a directory: null for a directory asked as a file, [] for a file asked as a directory",
    run: async (fresh) => {
      const b = await fresh();
      await b.write(".estoc/d/f", enc.encode("x"));
      same(await b.read(".estoc/d"), null, "read a directory");
      same(await b.size(".estoc/d"), null, "size of a directory");
      same(await b.modified(".estoc/d"), null, "modified of a directory");
      same(await b.list(".estoc/d/f"), [], "list a file");
      same(await b.dirs(".estoc/d/f"), [], "dirs of a file");
      same(await b.list(".estoc/d/f/deeper"), [], "list under a file");
      same(await b.read(".estoc/d/f/deeper"), null, "read under a file");
      same(await b.size(".estoc/d/f/deeper"), null, "size under a file");
      same(await b.size(".estoc/d/f"), 1, "the file itself");
    },
  },
  {
    name: "knows a file's size without reading it",
    run: async (fresh) => {
      const b = await fresh();
      await b.write(".estoc/f", enc.encode("héllo"));
      same(await b.size(".estoc/f"), 6, "size");
      await b.append(".estoc/f", enc.encode("!"));
      same(await b.size(".estoc/f"), 7, "size after append");
    },
  },
  {
    name: "knows when a file was written, and a rewrite renews it",
    run: async (fresh) => {
      const b = await fresh();
      await b.write(".estoc/blobs/x", enc.encode("x"));
      const first = await b.modified(".estoc/blobs/x");
      // a time, not compared with Date.now(): a file system's clock is rounded differently from the process's
      if (first === null || !Number.isFinite(first) || first <= 0) {
        throw new Error(`modified after write: ${String(first)}`);
      }
      await sleep(25);
      await b.write(".estoc/blobs/x", enc.encode("x"));
      const second = await b.modified(".estoc/blobs/x");
      if (second === null || second <= first) {
        throw new Error(`modified after rewrite: ${String(second)} is not after ${first}`);
      }
      // an append need not renew it (OPFS does not); a whole-file write must, and that is what a blob rewrite is
      await b.append(".estoc/blobs/x", enc.encode("y"));
      const third = await b.modified(".estoc/blobs/x");
      if (third === null || third < second) {
        throw new Error(`modified after append: ${String(third)} is before ${second}`);
      }
      await b.remove(".estoc/blobs/x");
      same(await b.modified(".estoc/blobs/x"), null, "modified after remove");
    },
  },
  {
    name: "removes, and removing a missing file is fine",
    run: async (fresh) => {
      const b = await fresh();
      await b.write(".estoc/blobs/a", enc.encode("{}"));
      await b.remove(".estoc/blobs/a");
      same(await b.read(".estoc/blobs/a"), null, "removed");
      await b.remove(".estoc/blobs/a");
      await b.remove(".estoc/never/was");
    },
  },
  {
    name: "hands back copies, not its own buffers",
    run: async (fresh) => {
      const b = await fresh();
      const data = enc.encode("abc");
      await b.write("f", data);
      data[0] = 0x7a;
      const read = (await b.read("f")) as Uint8Array;
      same(text(read), "abc", "kept its own copy");
      read[0] = 0x7a;
      same(text(await b.read("f")), "abc", "handed out a copy");
    },
  },
  {
    name: "r2-A: copies the bytes themselves, not what the input's own slice hands back — a Node Buffer's is a view onto its memory",
    run: async (fresh) => {
      // A Uint8Array whose `slice` is a view, as `Buffer.prototype.slice` is: what any backend is given in Node
      class Viewing extends Uint8Array {
        override slice(start?: number, end?: number): this {
          return this.subarray(start, end) as this;
        }
      }
      for (const method of ["write", "append"] as const) {
        const b = await fresh();
        const input = new Viewing([1, 2, 3]);
        await b[method]("f", input);
        input[0] = 9;
        const read = (await b.read("f")) as Uint8Array;
        same(Array.from(read), [1, 2, 3], `${method}: kept its own copy of a viewing input`);
        read[1] = 8;
        same(Array.from((await b.read("f")) as Uint8Array), [1, 2, 3], `${method}: handed out a copy`);
        // a later append onto the file, then the input changed again: still nothing of the caller's is the file
        await b.append("f", new Viewing([4]));
        input[2] = 7;
        same(Array.from((await b.read("f")) as Uint8Array), [1, 2, 3, 4], `${method}: the file after an append`);
      }
    },
  },
  {
    name: "r3-A: refuses to write below a file or onto a directory, leaving both as they were",
    run: async (fresh) => {
      const b = await fresh();
      await b.write("d/f", enc.encode("file"));
      for (const method of ["write", "append"] as const) {
        await rejects(b[method]("d/f/under", enc.encode("x")), /./, `${method} below a file`);
        await rejects(b[method]("d/f/deeper/still", enc.encode("x")), /./, `${method} two below a file`);
        await rejects(b[method]("d", enc.encode("x")), /./, `${method} onto a directory`);
      }
      same(text(await b.read("d/f")), "file", "the file is as it was");
      same(await b.read("d"), null, "the directory is not a file");
      same(await b.size("d/f/under"), null, "nothing landed below the file");
      same(await b.list("d"), ["f"], "the directory holds what it held");
      same(await b.dirs("d"), [], "no directory appeared under it");
      // and beside them everything still works
      await b.write("d/g", enc.encode("g"));
      same((await b.list("d")).sort(), ["f", "g"], "a sibling write");
    },
  },
  {
    name: "open: streams a file's bytes, null for a missing file or a directory, and a cancel is not an error",
    run: async (fresh) => {
      const b = await fresh();
      same(await b.open("nope"), null, "open a missing file");
      await b.write("d/f", enc.encode("file"));
      same(await b.open("d"), null, "open a directory");
      same(await b.open("d/f/under"), null, "open under a file");
      const large = bytesOf(200 * 1024 + 7, 1);
      await b.write("d/large", large);
      same(await drain(await b.open("d/large")), [...large], "the bytes streamed, whole");
      same(await drain(await b.open("d/f")), [...enc.encode("file")], "a small file");
      await b.write("d/empty", new Uint8Array(0));
      same(await drain(await b.open("d/empty")), [], "an empty file");
      const stream = (await b.open("d/large")) as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      const first = await reader.read();
      same(first.done, false, "a first chunk");
      await reader.cancel();
      same(await b.size("d/large"), large.length, "the file is untouched by a cancel");
    },
  },
  {
    name: "create: writes every chunk of a source in order, replaces, and a source that throws leaves what was there",
    run: async (fresh) => {
      const b = await fresh();
      const bytes = bytesOf(150 * 1024 + 3, 2);
      await b.create("o/new", chunks(bytes, 7_001));
      same([...((await b.read("o/new")) as Uint8Array)], [...bytes], "created from chunks");
      await b.create("o/new", chunks(enc.encode("replaced"), 3));
      same(text(await b.read("o/new")), "replaced", "replaced whole");
      async function* failing(): AsyncIterable<Uint8Array> {
        yield enc.encode("half");
        throw new Error("source gone");
      }
      await rejects(b.create("o/new", failing()), /source gone/, "the source's error");
      same(text(await b.read("o/new")), "replaced", "the old file stands");
      await rejects(b.create("o/fresh", failing()), /source gone/, "the source's error, fresh path");
      same(await b.read("o/fresh"), null, "nothing landed where there was nothing");
      same((await b.list("o")).sort(), ["new"], "no residue is listed beside it");
      await b.create("o/empty", chunks(new Uint8Array(0), 1));
      same(await b.size("o/empty"), 0, "an empty source makes an empty file");
      await b.write("o/f", enc.encode("f"));
      await rejects(b.create("o/f/under", chunks(enc.encode("x"), 1)), /./, "create below a file");
      same(text(await b.read("o/f")), "f", "the file in the way is as it was");
    },
  },
  {
    name: "r1-B: create to a fresh path shows nothing there — not even an empty file — until the source has ended",
    run: async (fresh) => {
      const b = await fresh();
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      async function* slow(): AsyncIterable<Uint8Array> {
        yield enc.encode("half");
        started();
        await gate;
        yield enc.encode("-done");
      }
      const create = b.create("o/fresh", slow());
      await ready;
      same(await b.size("o/fresh"), null, "nothing at the path while the source waits");
      same(await b.read("o/fresh"), null, "nor to read");
      release();
      await create;
      same(text(await b.read("o/fresh")), "half-done", "whole once the source has ended");
      same((await b.list("o")).sort(), ["fresh"], "and nothing left beside it");
    },
  },
  {
    name: "rename: moves a file, making parents, over an existing file whole; a missing source is an error",
    run: async (fresh) => {
      const b = await fresh();
      const bytes = bytesOf(100 * 1024 + 1, 3);
      await b.write("staging/x", bytes);
      await b.rename("staging/x", "objects/deep/y");
      same(await b.read("staging/x"), null, "the source is gone");
      same([...((await b.read("objects/deep/y")) as Uint8Array)], [...bytes], "the target has the bytes");
      same(await b.list("staging"), [], "nothing left in the source directory");
      await b.write("staging/z", enc.encode("new"));
      await b.rename("staging/z", "objects/deep/y");
      same(text(await b.read("objects/deep/y")), "new", "replaced over an existing file");
      same(await b.read("staging/z"), null, "and the source is gone");
      same((await b.list("objects/deep")).sort(), ["y"], "one file there");
      await rejects(b.rename("staging/nope", "objects/w"), /./, "no source");
      same(await b.read("objects/w"), null, "nothing appeared");
      await rejects(b.rename("staging/../x", "objects/w"), /unsafe/, "an unsafe source path");
    },
  },
  {
    name: "own: exclusive under one name — a second take is VaultOwned, refused at once; release lets the next take it; releasing twice is fine; another name is another vault",
    run: async (fresh) => {
      const b = await fresh();
      const first = await b.own(".estoc/local/owner.pid");
      await rejects(b.own(".estoc/local/owner.pid"), /owned elsewhere/, "a second take while the first holds");
      await rejects(b.own(".estoc/local/owner.pid"), /owned elsewhere/, "and again: nothing waits, nothing is stolen");
      const other = await b.own("other/local/owner.pid");
      await other.release();
      await first.release();
      await first.release();
      const second = await b.own(".estoc/local/owner.pid");
      await rejects(b.own(".estoc/local/owner.pid"), /owned elsewhere/, "the second holds now");
      await second.release();
      const third = await b.own(".estoc/local/owner.pid");
      await third.release();
      await rejects(b.own("../owner"), /relative|segment/, "a name outside the root");
    },
  },
  {
    name: "refuses what is not a plain relative path: .., ., a backslash, an absolute path, an empty segment",
    run: async (fresh) => {
      const b = await fresh();
      await rejects(b.read("../x"), /unsafe/, "read ..");
      await rejects(b.write("a/./b", enc.encode("")), /unsafe/, "write .");
      await rejects(b.list(""), /empty/, "list empty");
      // Windows reads a backslash as a separator: `..\\x` must not climb out of the root
      await rejects(b.write("..\\x", enc.encode("")), /unsafe/, "write ..\\x");
      await rejects(b.read("a\\b"), /unsafe/, "read a\\b");
      await rejects(b.write("/abs", enc.encode("")), /relative/, "write absolute");
      await rejects(b.write("a//b", enc.encode("")), /unsafe/, "write empty segment");
      await rejects(b.list("a/"), /unsafe/, "list trailing slash");
      same(await b.list("a"), [], "nothing was written");
    },
  },
];
