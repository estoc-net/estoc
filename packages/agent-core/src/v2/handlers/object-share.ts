import { OBJECT_SHARE } from "../../protocol/object-share.js";
import type { ProtocolHandler } from "../handler.js";

/**
 * object-share/1.0 (`docs/object-share.md`): a contact handed us an
 * object. Nothing to do on arrival: the share was checked and its blocks
 * kept as the message was recorded — the skeleton's `attachments` name
 * the root of a share that verified, and nothing of one that did not
 * (vault-events.md §3.1, §4) — so by the time a handler would see it the
 * object is in `blobs/` as far as it came, by CID, and the rest fills in
 * from wherever it arrives: the package the share names, when the
 * application fetches it, or a later share. The type is registered so
 * it is known mail. A reader that wants the verdict again runs
 * `verifyShare(msg, (cid) => blobs.getBlock(cid))`.
 */
export const objectShareHandler: ProtocolHandler = {
  types: [OBJECT_SHARE],
};
