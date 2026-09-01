/**
 * Lifting (vault-events.md §4, provisional): what is taken out of a
 * message's plaintext before it is recorded, and put back before it goes
 * out. A record's body is the plaintext *as stored*, not as it crossed
 * the wire — the trace keeps that. One thing is lifted today: the blocks
 * an object-share/1.0 carries. They are kept in `blobs/` by CID
 * (`keepShare` on the way in, `Agent.shareObject` on the way out), the
 * skeleton's `attachments[]` names their root, and the body keeps each
 * block attachment by `id` alone — the id is the CID, the name the block
 * is read by — its `data` gone, so the bytes are in the vault once,
 * whichever road and however many shares brought them, and an erase of
 * the root takes them. Delivery puts the bytes back (`fillBlocks`); a
 * reader that wants the object runs `verifyShare` over `blobs.getBlock`,
 * as it does for leaves that came by another road. A message nothing
 * was lifted from — a share that did not verify, a send naming no
 * `roots` — is stored as it came. Attachments carried inline in other
 * messages (`data.base64`, `data.json`) are not lifted yet (§11).
 */

import { isCid, type BlobStore, type Cid } from "@estoc/event-store";

import { bytesToBase64url } from "./protocol/object-share.js";
import type { PlainMessage } from "./records.js";

/** What lifting leaves of a message: the plaintext as it is stored, and the roots lifted out of it, for the skeleton's `attachments`. */
export interface Lifted {
  plaintext: PlainMessage;
  attachments: Cid[];
}

/** An attachment with an id, as the wire has it or as stored: `data` there or not. `media_type` is informative and not read. */
interface Named {
  id: string;
  data?: unknown;
  [extra: string]: unknown;
}

function named(attachment: unknown): attachment is Named {
  const a = attachment as Partial<Named> | null;
  return typeof a === "object" && a !== null && typeof a.id === "string";
}

/** What `blocksOf` takes for a block: an id and `data.base64`, whatever else the attachment says of itself. */
function carriesBytes(attachment: Named): boolean {
  const data = attachment.data as { base64?: unknown } | null | undefined;
  return typeof data === "object" && data !== null && typeof data.base64 === "string";
}

/** A block as stored: its id is a block's name and its `data` is gone. One with no `data` under some other id was not stripped here, and is left alone. */
function storedBlock(attachment: Named): boolean {
  return attachment.data === undefined && isCid(attachment.id);
}

/**
 * The plaintext as stored: every attachment carrying bytes (`id` and
 * `data.base64`, the block shape as `blocksOf` reads it — `media_type`
 * is informative and not consulted) whose bytes `kept` vouches for as
 * being in `blobs/` loses its `data`; the id names the block. Anything
 * else rides along as it came: an attachment of another shape, or one
 * `kept` does not know (a block beside a share that its tree does not
 * reach is recorded as a fact and never put). The message given is not
 * touched; one with nothing to strip is returned as it is.
 */
export async function stripBlocks(msg: PlainMessage, kept: (cid: string) => Promise<boolean> | boolean): Promise<PlainMessage> {
  if (msg.attachments === undefined) {
    return msg;
  }
  let changed = false;
  const stored: unknown[] = [];
  for (const attachment of msg.attachments) {
    if (named(attachment) && carriesBytes(attachment) && (await kept(attachment.id))) {
      const { data: _data, ...rest } = attachment;
      stored.push(rest);
      changed = true;
    } else {
      stored.push(attachment);
    }
  }
  return changed ? { ...msg, attachments: stored } : msg;
}

/**
 * The plaintext as it goes on the wire: every block stored without its
 * `data` — an attachment whose id is a block's name and whose `data`
 * is gone — gets the bytes back from `blobs/`, base64url as
 * `attachmentsOf` writes them. Throws naming the first block that is
 * not there — erased since, or never put — so a delivery says why it
 * cannot send what the record names. A message with nothing to fill is
 * returned as it is.
 */
export async function fillBlocks(msg: PlainMessage, blobs: Pick<BlobStore, "getBlock">): Promise<PlainMessage> {
  if (msg.attachments === undefined) {
    return msg;
  }
  let changed = false;
  const wire: unknown[] = [];
  for (const attachment of msg.attachments) {
    if (named(attachment) && storedBlock(attachment)) {
      const bytes = await blobs.getBlock(attachment.id);
      if (bytes === null) {
        throw new Error(`a block it carries is gone: ${attachment.id}`);
      }
      wire.push({ ...attachment, data: { base64: bytesToBase64url(bytes) } });
      changed = true;
    } else {
      wire.push(attachment);
    }
  }
  return changed ? { ...msg, attachments: wire } : msg;
}
