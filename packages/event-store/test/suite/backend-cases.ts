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
      const before = Date.now() - 1;
      await b.write(".estoc/blobs/x", enc.encode("x"));
      const first = await b.modified(".estoc/blobs/x");
      if (first === null || first < before) {
        throw new Error(`modified after write: ${String(first)} (before ${before})`);
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
