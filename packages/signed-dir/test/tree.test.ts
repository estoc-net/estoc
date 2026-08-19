import { describe, expect, it } from "vitest";
import {
  decodeDirNode,
  fileCid,
  hashTree,
  isDirCid,
  resolvePath,
  verifyTree,
} from "../src/index.js";
import type { TreeFiles } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function snapshot(): TreeFiles {
  return {
    "profile.json": utf8('{"name":"merely"}'),
    "posts/2026/first.html": utf8("<h1>hi</h1>"),
    "posts/2026/second.html": utf8("<h1>again</h1>"),
    "_redirects": utf8("/old/* /posts/:splat 303"),
  };
}

/** Object set as a relay would hold it: CID → bytes, nodes and files together. */
function objectSet(files: TreeFiles, tree: Awaited<ReturnType<typeof hashTree>>) {
  const objects = new Map<string, Uint8Array>(tree.nodes);
  for (const [cid, path] of tree.files) {
    objects.set(cid, files[path] as Uint8Array);
  }
  return objects;
}

describe("hashTree", () => {
  it("is deterministic and independent of insertion order", async () => {
    const a = await hashTree(snapshot());
    const reversed = Object.fromEntries(Object.entries(snapshot()).reverse());
    const b = await hashTree(reversed);
    expect(a.root).toBe(b.root);
  });

  it("root is a dag-json CID, files are raw CIDs", async () => {
    const tree = await hashTree(snapshot());
    expect(isDirCid(tree.root)).toBe(true);
    for (const cid of tree.files.keys()) {
      expect(isDirCid(cid)).toBe(false);
    }
  });

  it("changing one byte changes the root, unrelated subtrees keep their CIDs", async () => {
    const files = snapshot();
    const before = await hashTree(files);
    files["posts/2026/first.html"] = utf8("<h1>edited</h1>");
    const after = await hashTree(files);
    expect(after.root).not.toBe(before.root);
    // profile.json's CID unchanged → dedup across versions
    const profileCid = await fileCid(utf8('{"name":"merely"}'));
    expect(before.files.get(profileCid)).toBe("profile.json");
    expect(after.files.get(profileCid)).toBe("profile.json");
  });

  it("identical bytes at two paths share one CID", async () => {
    const files: TreeFiles = { "a.txt": utf8("same"), "b/c.txt": utf8("same") };
    const tree = await hashTree(files);
    expect(tree.files.size).toBe(1);
  });

  it("hashes the empty tree", async () => {
    const tree = await hashTree({});
    expect(isDirCid(tree.root)).toBe(true);
    expect(tree.files.size).toBe(0);
    expect(tree.nodes.size).toBe(1);
  });

  it("rejects a path that is both file and directory", async () => {
    await expect(
      hashTree({ posts: utf8("x"), "posts/a.txt": utf8("y") }),
    ).rejects.toThrow(/both a file and a directory/);
  });

  it("rejects unsafe paths", async () => {
    await expect(hashTree({ "../evil": utf8("x") })).rejects.toThrow(/unsafe/);
  });

  it("directory nodes decode to sorted entries with sizes", async () => {
    const tree = await hashTree(snapshot());
    const rootNode = decodeDirNode(tree.nodes.get(tree.root) as Uint8Array);
    expect(rootNode.map((e) => e.name)).toEqual([
      "_redirects",
      "posts",
      "profile.json",
    ]);
    const posts = rootNode.find((e) => e.name === "posts");
    expect(posts?.type).toBe("dir");
    // recursive size: both post files
    expect(posts?.size).toBe("<h1>hi</h1>".length + "<h1>again</h1>".length);
  });

  it("dir node wire form uses dag-json link notation", async () => {
    const tree = await hashTree(snapshot());
    const text = new TextDecoder().decode(tree.nodes.get(tree.root));
    expect(text).toContain('"hash":{"/":"');
  });
});

describe("verifyTree", () => {
  it("accepts a complete object set and lists every file", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const verified = await verifyTree(tree.root, objectSet(files, tree));
    expect([...verified.keys()].sort()).toEqual(Object.keys(files).sort());
  });

  it("rejects a missing object", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const someFileCid = [...tree.files.keys()][0] as string;
    objects.delete(someFileCid);
    await expect(verifyTree(tree.root, objects)).rejects.toThrow(/missing object/);
  });

  it("rejects tampered bytes", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    const someFileCid = [...tree.files.keys()][0] as string;
    objects.set(someFileCid, utf8("tampered"));
    await expect(verifyTree(tree.root, objects)).rejects.toThrow(/do not hash/);
  });

  it("ignores extra unrelated objects", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    objects.set(await fileCid(utf8("noise")), utf8("noise"));
    await expect(verifyTree(tree.root, objects)).resolves.toBeTruthy();
  });
});

describe("resolvePath", () => {
  it("walks to a file with O(depth) fetches, verifying each hop", async () => {
    const files = snapshot();
    const tree = await hashTree(files);
    const objects = objectSet(files, tree);
    let fetches = 0;
    const get = async (cid: string) => {
      fetches++;
      return objects.get(cid) ?? null;
    };
    const hit = await resolvePath(tree.root, "posts/2026/first.html", get);
    expect(hit.kind).toBe("file");
    expect(new TextDecoder().decode(hit.bytes)).toBe("<h1>hi</h1>");
    expect(fetches).toBe(4); // root + posts + 2026 + file
  });

  it("resolves the empty path to the root directory node", async () => {
    const tree = await hashTree(snapshot());
    const hit = await resolvePath(tree.root, "", async (cid) =>
      tree.nodes.get(cid) ?? null,
    );
    expect(hit.kind).toBe("dir");
    expect(hit.cid).toBe(tree.root);
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
    ).rejects.toThrow(/not found/);
  });
});

describe("golden vectors", () => {
  // Pinned outputs: if a dependency upgrade ever changes canonical
  // encoding, these fail loudly instead of silently re-rooting every tree.
  it("root CID of a fixed snapshot", async () => {
    const tree = await hashTree({
      "profile.json": utf8('{"name":"merely"}'),
      "posts/2026/first.html": utf8("<h1>hi</h1>"),
    });
    expect(tree.root).toBe(
      "baguqeeratnrwkjusjtipbt5trka34fb33x46prb26t7zn4re7bzaypbrx4ea",
    );
  });

  it("raw file CID matches an independently computed sha-256", async () => {
    // bafkrei… = CIDv1, raw codec, sha2-256 of the bare bytes
    expect(await fileCid(utf8("<h1>hi</h1>"))).toBe(
      "bafkreihh7o3pxp2m4kkjcpvwfnj76a5hkrtett64bwbe3hr2fncucubpp4",
    );
  });
});
