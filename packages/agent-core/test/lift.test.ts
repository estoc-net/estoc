import { describe, expect, it } from "vitest";

import { attachmentsOf, closureOf, fillBlocks, stripBlocks, type PlainMessage } from "../src/index.js";

describe("lifting a message's blocks (vault-events.md §4)", () => {
  const enc = new TextEncoder();
  const files = {
    "index.json": enc.encode(JSON.stringify({ format: "https://estoc.dev/post/1.0", id: "01900000-0000-7000-8000-000000000000" })),
    "files/a.txt": enc.encode("a"),
  };

  it("strips the blocks kept, leaves the rest as it came, and fills them back from the store", async () => {
    const { blocks } = await closureOf(files);
    expect(blocks.size).toBe(4); // two directory nodes, two raw files
    const [first] = [...blocks.keys()].sort() as [string];
    const link = { id: "pkg", media_type: "application/vnd.ipld.car", byte_count: 3, data: { links: ["https://store/b/x"], hash: "bciq" } };
    const msg: PlainMessage = { id: "m", type: "t", body: { root: "r" }, attachments: [...attachmentsOf(blocks), link, "not an attachment"] };

    const stored = await stripBlocks(msg, (cid) => cid !== first);
    const attachments = stored.attachments as ({ id: string; media_type: string; byte_count: number; data?: unknown } | string)[];
    expect(attachments).toHaveLength(blocks.size + 2);
    for (const attachment of attachments.slice(0, blocks.size) as { id: string; media_type: string; byte_count: number; data?: unknown }[]) {
      // the one not kept as it came; the rest by id, media type and size, no bytes
      expect(attachment.data === undefined).toBe(attachment.id !== first);
      expect(attachment.byte_count).toBe(blocks.get(attachment.id)?.length);
    }
    expect(attachments.slice(blocks.size)).toEqual([link, "not an attachment"]);
    // the message given is not touched
    expect((msg.attachments as { data?: unknown }[]).every((a) => typeof a === "string" || a.data !== undefined)).toBe(true);

    const filled = await fillBlocks(stored, { getBlock: async (cid) => blocks.get(cid) ?? null });
    expect(filled).toEqual(msg);

    // nothing to do: the same message back
    expect(await stripBlocks(msg, () => false)).toBe(msg);
    expect(await fillBlocks(msg, { getBlock: async () => null })).toBe(msg);
    const none: PlainMessage = { id: "m", type: "t", body: {} };
    expect(await stripBlocks(none, () => true)).toBe(none);
    expect(await fillBlocks(none, { getBlock: async () => null })).toBe(none);
  });

  it("a block that is gone fails the fill, named", async () => {
    const { blocks } = await closureOf(files);
    const stored = await stripBlocks({ id: "m", type: "t", body: {}, attachments: attachmentsOf(blocks) }, () => true);
    const [gone] = [...blocks.keys()].sort() as [string];
    await expect(fillBlocks(stored, { getBlock: async (cid) => (cid === gone ? null : (blocks.get(cid) ?? null)) })).rejects.toThrow(
      `a block it carries is gone: ${gone}`
    );
  });
});
