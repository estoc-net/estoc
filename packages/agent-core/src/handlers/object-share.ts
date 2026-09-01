import type { BlobStore } from "@estoc/event-store";

import { OBJECT_SHARE, missingBytes, verifyShare, type VerifiedShare } from "../protocol/object-share.js";
import type { ProtocolHandler } from "../handler.js";
import { stripBlocks, type Lifted } from "../lift.js";
import type { PlainMessage } from "../records.js";

/**
 * object-share/1.0 (`docs/object-share.md`): a contact handed us an
 * object. Nothing to do on arrival: the share was checked and its blocks
 * kept as the message was recorded (`keepShare`) — the skeleton's
 * `attachments` name the root of a share that verified, and nothing of
 * one that did not (vault-events.md §3.1, §4) — so by the time a handler
 * would see it the object is in `blobs/` as far as it came, by CID, and
 * the rest fills in from wherever it arrives: the package the share
 * names, when the application fetches it, or a later share. The type is
 * registered so it is known mail. A reader that wants the verdict again
 * runs `verifyShare(msg, (cid) => blobs.getBlock(cid))` — over `blobs/`,
 * where the record's blocks are: its body names them by id (`lift.ts`).
 */
export const objectShareHandler: ProtocolHandler = {
  types: [OBJECT_SHARE],
};

/**
 * The receiving side, run before the message is recorded — the lifting
 * of a share (`lift.ts`, vault-events.md §4): one that verifies has
 * every block its tree reaches put in `blobs/`, its root returned for
 * the skeleton's `attachments`, and its plaintext returned as it is
 * stored — those blocks' attachments by id alone, the bytes in the
 * vault once. One that does not verify is noted and yields the message
 * as it came, a fact about what arrived, with nothing lifted; the
 * application runs the same check to decide how to show it. A block the
 * message carries beside the tree is neither put nor stripped: it stays
 * in the record as it came. A share whose leaves are not all here is a
 * partial object, kept as far as it goes: `blobs/` is by CID, so leaves
 * that arrived by another road count as present and the rest fills in
 * later.
 */
export async function keepShare(msg: PlainMessage, blobs: BlobStore, log: (line: string) => void): Promise<Lifted> {
  let share: VerifiedShare;
  try {
    share = await verifyShare(msg, (cid) => blobs.getBlock(cid));
  } catch (err) {
    log(`an object-share does not verify; recorded as it came: ${err instanceof Error ? err.message : String(err)}`);
    return { plaintext: msg, attachments: [] };
  }
  for (const [cid, bytes] of share.blocks) {
    await blobs.putBlock(cid, bytes);
  }
  const who = share.card === null ? "unsigned" : `signed by ${share.card.did}`;
  const road =
    share.package !== null
      ? ` (${share.package.byteCount} bytes packaged at ${share.package.url} until ${share.package.availableUntil})`
      : share.packageProblem !== null
        ? ` (a package is named but unusable: ${share.packageProblem})`
        : "";
  const state = share.complete ? "" : `, ${share.tree.partial.size} awaiting ${missingBytes(share.tree)} bytes${road}`;
  log(`${share.object.meta.format} ${share.root} (${who}): ${share.tree.files.size} files kept${state}`);
  return { plaintext: await stripBlocks(msg, (cid) => share.blocks.has(cid)), attachments: [share.root] };
}
