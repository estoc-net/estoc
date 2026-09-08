import { describe, expect, it } from "vitest";

import { FolderFileStore, MemoryBackend, utf8 } from "../../../src/v3/index.js";
import { expectBytes } from "../suite/helpers.js";

const BASE = ".estoc";

/** A folder with every kind of entry the layout knows, and some it does not. */
function populated(): MemoryBackend {
  const backend = new MemoryBackend();
  const files: Record<string, string> = {
    [`${BASE}/config.json`]: "{}",
    [`${BASE}/keystore.json`]: "{}",
    [`${BASE}/events/019b2a43-4a56-7c0f-862f-194c0c4124a0/019b2a43-5c8d-75a0-bf82-b2a61a4ce099.jsonl`]: "",
    [`${BASE}/events/stray.txt`]: "",
    [`${BASE}/objects/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq`]: "hello",
    [`${BASE}/objects/not-a-cid`]: "",
    [`${BASE}/import/019b2a43-4a56-7c0f-862f-194c0c4124a0/journal.json`]: "{}",
    [`${BASE}/local/replica.json`]: "{}",
    [`${BASE}/local/agent/options.json`]: "{}",
    [`${BASE}/notes/readme.md`]: "# hi",
    [`${BASE}/state/x.json`]: "{}",
    [`${BASE}/z`]: "",
  };
  for (const [path, content] of Object.entries(files)) backend.files.set(path, utf8(content));
  return backend;
}

describe("FolderFileStore", () => {
  it("lists config.json, keystore.json and the opaque portable paths, in code-point order — never a segment, an object, or anything under local/ or import/, and no damage", async () => {
    const files = new FolderFileStore(populated(), BASE);
    expect(await files.list()).toEqual(["config.json", "keystore.json", "notes/readme.md", "state/x.json", "z"]);
  });

  it("reads the two singletons and the opaque paths; a structural path is not a portable file path", async () => {
    const files = new FolderFileStore(populated(), BASE);
    expectBytes(await files.read("config.json"), utf8("{}"));
    expectBytes(await files.read("notes/readme.md"), utf8("# hi"));
    expect(await files.read("notes/missing")).toBeNull();
    for (const path of ["local/replica.json", "import/x", "events/stray.txt", "objects/not-a-cid", "events", "local"]) {
      await expect(files.read(path), path).rejects.toThrow(/not a portable file path/);
    }
    await expect(files.read("../x")).rejects.toThrow(/relative/);
  });

  it("writes an opaque path whole — state/ is just another opaque directory — and refuses every owned path", async () => {
    const backend = populated();
    const files = new FolderFileStore(backend, BASE);
    await files.write("state/y.json", utf8("{}"));
    await files.write("state/x.json", utf8('{"n":2}'));
    expectBytes(await files.read("state/x.json"), utf8('{"n":2}'));
    expect(await files.list()).toEqual(["config.json", "keystore.json", "notes/readme.md", "state/x.json", "state/y.json", "z"]);
    for (const path of ["config.json", "keystore.json", "events/x", "objects/x", "import/x", "local/x", "local/agent/options.json"]) {
      await expect(files.write(path, utf8("")), path).rejects.toThrow(/owned by the layout/);
    }
    expect(backend.files.get(`${BASE}/config.json`)).toEqual(utf8("{}"));
  });

  it("refuses a path that would make one name both a file and a directory, leaving both as they were", async () => {
    const backend = populated();
    const files = new FolderFileStore(backend, BASE);
    await expect(files.write("notes", utf8(""))).rejects.toThrow(/is a directory/);
    await expect(files.write("z/under", utf8(""))).rejects.toThrow(/is a file/);
    await expect(files.write("notes/readme.md/under", utf8(""))).rejects.toThrow(/is a file/);
    expect(await files.list()).toEqual(["config.json", "keystore.json", "notes/readme.md", "state/x.json", "z"]);
    await expect(files.write("x", "text" as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });
});
