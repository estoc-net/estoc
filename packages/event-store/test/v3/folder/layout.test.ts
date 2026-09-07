import { describe, expect, it } from "vitest";

import { OWNED_ROOTS, REPLICA_FILE, authorDir, isSegmentName, kindOf, prettyJson, segmentPath, text } from "../../../src/v3/index.js";
import { authorN } from "../suite/helpers.js";

const SEG = "019b2a43-5c8d-75a0-bf82-b2a61a4ce099";
const RAW = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";

describe("layout (vault-folder.md §3)", () => {
  it("names the six structural roots the file store refuses", () => {
    expect(OWNED_ROOTS).toEqual(["config.json", "keystore.json", "events", "objects", "import", "local"]);
    expect(REPLICA_FILE).toBe("local/replica.json");
  });

  it("a segment is <uuidv7>.jsonl, lowercase, and nothing else (§8)", () => {
    expect(isSegmentName(`${SEG}.jsonl`)).toBe(true);
    for (const bad of [SEG, `${SEG}.json`, `${SEG.toUpperCase()}.jsonl`, `${SEG.replace("-7", "-4")}.jsonl`, ".jsonl", `x${SEG}.jsonl`, `${SEG}.jsonl.tmp`]) {
      expect(isSegmentName(bad), bad).toBe(false);
    }
    expect(segmentPath(authorN(1), SEG)).toBe(`events/${authorN(1)}/${SEG}.jsonl`);
    expect(authorDir(authorN(1))).toBe(`events/${authorN(1)}`);
  });

  it("VF-16: kindOf tells the layout's own paths from opaque files, and an unknown entry inside a structural root is damage", () => {
    expect(kindOf("config.json")).toBe("config");
    expect(kindOf("keystore.json")).toBe("keystore");
    expect(kindOf(segmentPath(authorN(1), SEG))).toBe("segment");
    expect(kindOf(`objects/${RAW}`)).toBe("object");
    expect(kindOf("import/journal.json")).toBe("import");
    expect(kindOf("import/staging/x")).toBe("import");
    expect(kindOf("local/replica.json")).toBe("local");
    expect(kindOf("local/agent/cache/index.json")).toBe("local");
    for (const opaque of ["README.md", "notes/2026.txt", "events.json", "objects.txt", "state/x.json", "config.json.bak"]) {
      expect(kindOf(opaque), opaque).toBe("opaque");
    }
    const damage = [
      "config.json/x", // a file where the layout has a directory
      "keystore.json/x",
      "events/readme.txt", // a file beside the author directories
      `events/${SEG}.jsonl`, // a segment with no author directory
      "events/not-an-author/x.jsonl",
      `events/${authorN(1).toUpperCase()}/${SEG}.jsonl`, // an author directory not canonical
      `events/${authorN(1)}/notes.txt`,
      `events/${authorN(1)}/${SEG}`, // a segment name without the suffix
      `events/${authorN(1)}/${SEG}.jsonl/x`, // a directory where a segment belongs
      `events/${authorN(1)}/sub/${SEG}.jsonl`,
      "objects/not-a-cid",
      `objects/${RAW}/x`,
      "objects/bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", // dag-cbor, not raw
      `objects/${RAW.toUpperCase()}`,
      "objects/a/b",
    ];
    for (const path of damage) expect(kindOf(path), path).toBe("damage");
  });

  it("a JSON file is pretty-printed and ends in LF (§2)", () => {
    expect(text(prettyJson({ a: 1, b: [1, 2] }))).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  });
});
