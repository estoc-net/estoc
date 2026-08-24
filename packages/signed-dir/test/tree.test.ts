import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import {
  fileCid,
  hashTree,
  isDagPbCid,
  isRawCid,
  resolvePath,
  verifyTree,
} from "../src/index.js";
import type { HashedTree, TreeFiles } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function snapshot(): TreeFiles {
  return {
    "profile.json": utf8('{"name":"merely"}'),
    "posts/2026/first.html": utf8("<h1>hi</h1>"),
    "posts/2026/second.html": utf8("<h1>again</h1>"),
    "_redirects": utf8("/old/* /posts/:splat 303"),
  };
}

/** A file big enough to chunk under the profile (1 MiB chunks). */
function bigFile(mib: number): Uint8Array {
  const bytes = new Uint8Array(mib * 1024 * 1024 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

/**
 * Object set as a relay would hold it: `nodes` plus, for each file root
 * CID `nodes` doesn't already hold (single-block files), the input bytes.
 */
function objectSet(files: TreeFiles, tree: HashedTree) {
  const objects = new Map<string, Uint8Array>(tree.nodes);
  for (const [cid, path] of tree.files) {
    if (!objects.has(cid)) objects.set(cid, files[path] as Uint8Array);
  }
  return objects;
}

/** dag-pb bytes + CID of a hand-built UnixFS directory node. */
async function dirNode(links: dagPb.PBLink[]) {
  const bytes = dagPb.encode(
    dagPb.prepare({
      Data: new UnixFS({ type: "directory" }).marshal(),
      Links: links,
    }),
  );
  const digest = await sha256.digest(bytes);
  const cid = CID.create(1, dagPb.code, digest).toString();
  return { cid, bytes };
}

describe("hashTree", () => {
  it("is deterministic and independent of insertion order", async () => {
    const a = await hashTree(snapshot());
    const reversed = Object.fromEntries(Object.entries(snapshot()).reverse());
    const b = await hashTree(reversed);
    expect(a.root).toBe(b.root);
  });

  it("root is a dag-pb CID, small files keep their raw CIDs", async () => {
    const tree = await hashTree(snapshot());
    expect(isDagPbCid(tree.root)).toBe(true);
    for (const cid of tree.files.keys()) {
      expect(isRawCid(cid)).toBe(true);
    }
  });

  it("a single-block file's CID equals the raw CID of its bytes — unchanged from the dag-json branch", async () => {
    const tree = await hashTree(snapshot());
    const profileCid = await fileCid(utf8('{"name":"merely"}'));
    expect(tree.files.get(profileCid)).toBe("profile.json");
    // and its bytes are not duplicated into nodes
    expect(tree.nodes.has(profileCid)).toBe(false);
  });

  it("changing one byte changes the root, unrelated files keep their CIDs", async () => {
    const files = snapshot();
    const before = await hashTree(files);
    files["posts/2026/first.html"] = utf8("<h1>edited</h1>");
    const after = await hashTree(files);
    expect(after.root).not.toBe(before.root);
    const profileCid = await fileCid(utf8('{"name":"merely"}'));
    expect(before.files.get(profileCid)).toBe("profile.json");
    expect(after.files.get(profileCid)).toBe("profile.json");
  });

  it("identical bytes at two paths share one CID", async () => {
    const files: TreeFiles = { "a.txt": utf8("same"), "b/c.txt": utf8("same") };
    const tree = await hashTree(files);
    expect(tree.files.size).toBe(1);
  });

  it("rejects the empty tree — empty directories have no encoding here", async () => {
    await expect(hashTree({})).rejects.toThrow(/empty/);
  });

  it("hashes the empty file", async () => {
    const files: TreeFiles = { "empty.bin": new Uint8Array(0) };
    const tree = await hashTree(files);
    const verified = await verifyTree(tree.root, objectSet(files, tree));
    expect([...verified.keys()]).toEqual(["empty.bin"]);
  });

  it("rejects a path that is both file and directory", async () => {
    await expect(
      hashTree({ posts: utf8("x"), "posts/a.txt": utf8("y") }),
    ).rejects.toThrow(/both a file and a directory/);
  });

  it("rejects unsafe paths", async () => {
    await expect(hashTree({ "../evil": utf8("x") })).rejects.toThrow(/unsafe/);
  });

  it("rejects two spellings of one path", async () => {
    await expect(
      hashTree({ "a/b": utf8("x"), "a//b": utf8("y") }),
    ).rejects.toThrow(/duplicate path/);
  });

  it("a chunked file roots in dag-pb with its blocks in nodes", async () => {
    const files: TreeFiles = { "big.bin": bigFile(2) };
    const tree = await hashTree(files);
    const [cid, path] = [...tree.files.entries()][0] as [string, string];
    expect(path).toBe("big.bin");
    expect(isDagPbCid(cid)).toBe(true);
    // file root node + 3 raw leaves (1 MiB, 1 MiB, 7 B) + root dir
    expect(tree.nodes.has(cid)).toBe(true);
    expect(tree.nodes.size).toBe(5);
  });
});

describe("verifyTree", () => {
  it("accepts a complete object set and lists every file", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const verified = await verifyTree(tree.root, objectSet(files, tree));
    expect([...verified.keys()].sort()).toEqual(Object.keys(files).sort());
  });

  it("round-trips a chunked file", async () => {
    const files: TreeFiles = { "big.bin": bigFile(2), "small.txt": utf8("s") };
    const tree = await hashTree(files);
    const verified = await verifyTree(tree.root, objectSet(files, tree));
    expect([...verified.keys()].sort()).toEqual(["big.bin", "small.txt"]);
  });

  it("rejects a missing leaf chunk of a chunked file", async () => {
    const files: TreeFiles = { "big.bin": bigFile(2) };
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const someLeaf = [...tree.nodes.keys()].find((c) => isRawCid(c)) as string;
    objects.delete(someLeaf);
    await expect(verifyTree(tree.root, objects)).rejects.toThrow(
      /missing object/,
    );
  });

  it("rejects a missing object", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const someFileCid = [...tree.files.keys()][0] as string;
    objects.delete(someFileCid);
    await expect(verifyTree(tree.root, objects)).rejects.toThrow(
      /missing object/,
    );
  });

  it("rejects tampered bytes", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const someFileCid = [...tree.files.keys()][0] as string;
    objects.set(someFileCid, utf8("tampered"));
    await expect(verifyTree(tree.root, objects)).rejects.toThrow(
      /do not hash/,
    );
  });

  it("ignores extra unrelated objects", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    objects.set(await fileCid(utf8("noise")), utf8("noise"));
    await expect(verifyTree(tree.root, objects)).resolves.toBeTruthy();
  });

  it("rejects an empty directory node", async () => {
    const empty = await dirNode([]);
    await expect(
      verifyTree(empty.cid, new Map([[empty.cid, empty.bytes]])),
    ).rejects.toThrow(/empty directory/);
  });

  it("rejects a nested empty directory", async () => {
    const empty = await dirNode([]);
    const parent = await dirNode([
      { Name: "hollow", Hash: CID.parse(empty.cid), Tsize: empty.bytes.length },
    ]);
    const objects = new Map([
      [empty.cid, empty.bytes],
      [parent.cid, parent.bytes],
    ]);
    await expect(verifyTree(parent.cid, objects)).rejects.toThrow(
      /empty directory/,
    );
  });

  it("rejects links out of canonical order", async () => {
    // @ipld/dag-pb's encode enforces sorted links, so craft the
    // protobuf by hand: PBLink{Hash=1,Name=2,Tsize=3}, PBNode with
    // Links (field 2) before Data (field 1). Lengths stay < 128 so
    // every varint is one byte.
    const link = (cid: string, name: string): number[] => {
      const hash = CID.parse(cid).bytes;
      const nameBytes = utf8(name);
      const body = [
        0x0a, hash.length, ...hash,
        0x12, nameBytes.length, ...nameBytes,
        0x18, 1,
      ];
      return [0x12, body.length, ...body];
    };
    const a = await fileCid(utf8("a"));
    const b = await fileCid(utf8("b"));
    const data = new UnixFS({ type: "directory" }).marshal();
    const bytes = new Uint8Array([
      ...link(a, "zebra"),
      ...link(b, "apple"),
      0x0a, data.length, ...data,
    ]);
    const digest = await sha256.digest(bytes);
    const cid = CID.create(1, dagPb.code, digest).toString();
    const objects = new Map([
      [cid, bytes],
      [a, utf8("a")],
      [b, utf8("b")],
    ]);
    await expect(verifyTree(cid, objects)).rejects.toThrow(/canonical order/);
  });

  it("rejects a raw root — the root must be a directory", async () => {
    const cid = await fileCid(utf8("just a file"));
    await expect(
      verifyTree(cid, new Map([[cid, utf8("just a file")]])),
    ).rejects.toThrow(/not a UnixFS directory/);
  });
});

describe("HAMT sharding", () => {
  // Enough long-named entries that the flat node's serialized size
  // crosses the profile's 256 KiB block-bytes threshold and the
  // importer shards on its own — no injected knob.
  const wideName = (i: number) =>
    `entry-${String(i).padStart(4, "0")}-${"x".repeat(80)}`;
  const wideDir = (): TreeFiles =>
    Object.fromEntries(
      Array.from({ length: 2200 }, (_, i) => [wideName(i), utf8("x")]),
    );

  it("a naturally sharded directory round-trips verify and resolve", async () => {
    const files = wideDir();
    const tree = await hashTree(files);
    const rootData = dagPb.decode(
      tree.nodes.get(tree.root) as Uint8Array,
    ).Data as Uint8Array;
    expect(UnixFS.unmarshal(rootData).type).toBe("hamt-sharded-directory");
    // Cross-checked against kubo 0.43.0 (unixfs-v1-2025 profile applied,
    // same 2200 files): ipfs add -r -Q --offline hamt-fixture/
    expect(tree.root).toBe(
      "bafybeigjbieb3arzjkcyfyggx2xvl6p7bdattx3bl77jmifshwxa3jr5oy",
    );
    const objects = objectSet(files, tree);
    const verified = await verifyTree(tree.root, objects);
    expect(verified.size).toBe(2200);
    const hit = await resolvePath(
      tree.root,
      wideName(1234),
      async (c) => objects.get(c) ?? null,
    );
    expect(new TextDecoder().decode(hit.bytes)).toBe("x");
  });
});

describe("resolvePath", () => {
  it("walks to a file, verifying each hop", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const fetched: string[] = [];
    const get = async (cid: string) => {
      fetched.push(cid);
      return objects.get(cid) ?? null;
    };
    const hit = await resolvePath(tree.root, "posts/2026/first.html", get);
    expect(hit.kind).toBe("file");
    expect(new TextDecoder().decode(hit.bytes)).toBe("<h1>hi</h1>");
    // O(depth) for a single-block file: root + posts + 2026 + file
    expect(new Set(fetched).size).toBe(4);
  });

  it("reassembles a chunked file", async () => {
    const files: TreeFiles = { "big.bin": bigFile(2) };
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const hit = await resolvePath(
      tree.root,
      "big.bin",
      async (c) => objects.get(c) ?? null,
    );
    expect(hit.kind).toBe("file");
    expect(hit.bytes.length).toBe((files["big.bin"] as Uint8Array).length);
    expect(hit.bytes).toEqual(files["big.bin"]);
  });

  it("resolves the empty path to the root directory node", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const hit = await resolvePath(tree.root, "", async (cid) =>
      tree.nodes.get(cid) ?? null,
    );
    expect(hit.kind).toBe("dir");
    expect(hit.cid).toBe(tree.root);
    expect(hit.bytes).toEqual(tree.nodes.get(tree.root));
  });

  it("rejects a served object whose bytes do not match", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    await expect(
      resolvePath(tree.root, "profile.json", async () => utf8("lies")),
    ).rejects.toThrow(/do not hash/);
  });

  it("errors on a path that is not there", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    await expect(
      resolvePath(tree.root, "posts/2027/x", async (c) => objects.get(c) ?? null),
    ).rejects.toThrow();
  });
});

describe("golden vectors", () => {
  // Pinned outputs: if a dependency upgrade ever changes the encoding,
  // these fail loudly instead of silently re-rooting every tree.
  it("root CID of a fixed snapshot — cross-checked against kubo", async () => {
    // Independently reproduced with kubo 0.43.0:
    //   ipfs config profile apply unixfs-v1-2025
    //   ipfs add -r -Q --offline fixture/     (same two files)
    // → bafybeic47ugcluinaquemujs7s63cfo7og2ucuqnl56zawlsikwcbmavle
    const tree = await hashTree({
      "profile.json": utf8('{"name":"merely"}'),
      "posts/2026/first.html": utf8("<h1>hi</h1>"),
    });
    expect(tree.root).toBe(
      "bafybeic47ugcluinaquemujs7s63cfo7og2ucuqnl56zawlsikwcbmavle",
    );
  });

  it("chunked file root CID — cross-checked against kubo", async () => {
    // Same 2 MiB + 7 B pattern file through kubo 0.43.0 with the
    // unixfs-v1-2025 profile applied: ipfs add -Q --offline big.bin
    const tree = await hashTree({ "big.bin": bigFile(2) });
    expect([...tree.files.keys()][0]).toBe(
      "bafybeici7b6wgforprflfnhxce7smeicrydora5wkmqfef53nrnbj5ji7y",
    );
  });

  it("raw file CID matches an independently computed sha-256", async () => {
    // bafkrei… = CIDv1, raw codec, sha2-256 of the bare bytes
    expect(await fileCid(utf8("<h1>hi</h1>"))).toBe(
      "bafkreihh7o3pxp2m4kkjcpvwfnj76a5hkrtett64bwbe3hr2fncucubpp4",
    );
  });
});
