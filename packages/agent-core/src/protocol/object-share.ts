import {
  hashTree,
  isDagPbCid,
  isInsideFiles,
  MalformedObjectError,
  parseIndex,
  resolvePath,
  verifyCard,
  verifyTree,
  type FolderObject,
  type GetBlock,
  type ObjectCard,
  type TreeFiles,
  type VerifiedTree,
} from "@estoc/folder-object";

import type { PlainMessage } from "../vault/messages.js";
import type { ProtocolHandler } from "./handler.js";

/**
 * object-share/1.0 (`docs/object-share.md`): hand a contact a whole
 * object — a folder-object hashed into a UnixFS tree. One message
 * carries the root in the body and blocks as attachments named by their
 * CID: always the tree's **skeleton** (every dag-pb block) and
 * `index.json`, and every leaf when the whole closure fits. Nothing is
 * asked back over DIDComm; leaves a share does not carry are named and
 * sized by the skeleton, and come by another road or a later share.
 *
 * What is shared is an object — a tree that declares what it is
 * (`index.json`); a well-hashed tree that is not one does not verify,
 * however good its hashes. A share may carry a card, and then it is a
 * signed object: the card is testimony about the object, not about the
 * message. Its `did` is whoever signed — the sender's own anchor for
 * something they stand behind, or the original author's when the sender
 * passes a signed object on. The envelope proves who sent; the card,
 * when there is one, proves who stands behind the object. Without a
 * card the share says only what the envelope says: this contact handed
 * me this object.
 */
export const OBJECT_SHARE = "https://estoc.dev/object-share/1.0/share";

/** IPLD block media types, as the IPFS ecosystem names them. */
export const DAG_PB_MEDIA_TYPE = "application/vnd.ipld.dag-pb";
export const RAW_MEDIA_TYPE = "application/vnd.ipld.raw";

/** The raw block bytes one share may carry by default: what a mediator queue comfortably holds. */
export const DEFAULT_MAX_SHARE_BYTES = 1024 * 1024;

export interface ObjectShareBody {
  /** CID of the object's root directory node: the name of the tree the attachments make */
  root: string;
  /** compact JWS over `{did, root}` — folder-object's card; present, the share is a signed object */
  card?: string;
}

/**
 * One block of the closure as a DIDComm attachment. The `id` is the CID
 * and is the only name the block has: DIDComm's `data.hash` is not used,
 * because it is defined alongside `links`, not `base64`, and
 * didcomm-rust drops it from an inline attachment.
 */
export interface BlockAttachment {
  id: string;
  media_type: string;
  byte_count: number;
  data: { base64: string };
}

/** The closure of a tree: its root, every block the root reaches, and the blocks a share must carry. */
export interface Closure {
  root: string;
  /** every block, CID → bytes */
  blocks: Map<string, Uint8Array>;
  /**
   * The minimal share (`docs/object-share.md` §2): every dag-pb block —
   * the skeleton — plus the blocks of `index.json`. A subset of `blocks`.
   */
  minimal: Map<string, Uint8Array>;
}

/**
 * What a verified share yields: the root, who (if anyone) stands behind
 * it, the tree, the object as far as its bytes are here, and the blocks.
 */
export interface VerifiedShare {
  root: string;
  /** the verified card, or null for an object shared without one */
  card: ObjectCard | null;
  /** the verified tree; `tree.missing` names the leaves not held, `tree.partial` their files */
  tree: VerifiedTree;
  /**
   * The object read out of the tree: `index.json` (always here) and every
   * file under `files/` whose bytes are all here. A partial file is not in
   * `object.tree` at all — it is in `tree.partial`.
   */
  object: FolderObject;
  /** true when no leaf is missing: the object is whole */
  complete: boolean;
  /** every block held — the message's, and any the caller supplied — CID → bytes */
  blocks: Map<string, Uint8Array>;
}

/**
 * Hash a tree and gather the complete object set: `hashTree`'s `nodes`
 * plus the input bytes of every single-block file (which it
 * deliberately does not copy) — and, apart, the minimal share.
 */
export async function closureOf(files: TreeFiles): Promise<Closure> {
  const hashed = await hashTree(files);
  const blocks = new Map(hashed.nodes);
  for (const [cid, path] of hashed.files) {
    if (!blocks.has(cid)) {
      blocks.set(cid, files[path] as Uint8Array);
    }
  }
  const minimal = new Map<string, Uint8Array>();
  for (const [cid, bytes] of blocks) {
    if (isDagPbCid(cid)) {
      minimal.set(cid, bytes);
    }
  }
  // index.json's blocks: its raw CID, or the chunks of a chunked one —
  // which a walk over the skeleton alone names, as that file's gaps
  const index = [...hashed.files].find(([, path]) => path === "index.json");
  if (index !== undefined) {
    const [cid] = index;
    const chunks = isDagPbCid(cid)
      ? ((await verifyTree(hashed.root, minimal, { leaves: "optional" })).partial.get("index.json") ?? [])
      : [cid];
    for (const chunk of chunks) {
      minimal.set(chunk, blocks.get(chunk) as Uint8Array);
    }
  }
  return { root: hashed.root, blocks, minimal };
}

/** The bytes of a closure, summed. */
export function closureSize(blocks: Map<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of blocks.values()) {
    total += bytes.length;
  }
  return total;
}

/** Blocks as attachments, one each, in CID order so two shares of one tree are alike. */
export function attachmentsOf(blocks: Map<string, Uint8Array>): BlockAttachment[] {
  return [...blocks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cid, bytes]) => ({
      id: cid,
      media_type: isDagPbCid(cid) ? DAG_PB_MEDIA_TYPE : RAW_MEDIA_TYPE,
      byte_count: bytes.length,
      data: { base64: bytesToBase64url(bytes) },
    }));
}

/**
 * The blocks a share message carries, CID → bytes. Only attachments of
 * the block shape count; anything else riding along is ignored. Whether
 * the bytes match their CID is `verifyShare`'s question.
 */
export function blocksOf(msg: PlainMessage): Map<string, Uint8Array> {
  const blocks = new Map<string, Uint8Array>();
  for (const attachment of msg.attachments ?? []) {
    const a = attachment as Partial<BlockAttachment>;
    const cid = a.id;
    const base64 = a.data?.base64;
    if (typeof cid !== "string" || typeof base64 !== "string") {
      continue;
    }
    try {
      blocks.set(cid, base64urlToBytes(base64));
    } catch {
      // not base64: not a block
    }
  }
  return blocks;
}

/**
 * Check a share message end to end: the skeleton carried reaches every
 * path under `body.root` with matching hashes, `index.json` is here and
 * well-formed, every leaf present hashes to its CID, and the card, if
 * there is one, verifies under its own did:key and is about this very
 * root. Leaves under `files/` may be absent: the result says which
 * (`tree.missing`, `tree.partial`, `complete`). Blocks the message does
 * not carry are looked up through `held` when given — the vault's
 * `blobs/`, so leaves that arrived by another road count as present.
 * Throws naming the first thing wrong.
 */
export async function verifyShare(msg: PlainMessage, held?: GetBlock): Promise<VerifiedShare> {
  const body = msg.body as Partial<ObjectShareBody>;
  if (typeof body.root !== "string") {
    throw new Error("object-share message has no root");
  }
  const root = body.root;
  let card: ObjectCard | null = null;
  if (body.card !== undefined) {
    if (typeof body.card !== "string") {
      throw new Error("object-share card is not a JWS");
    }
    card = await verifyCard(body.card);
    if (card.root !== root) {
      throw new Error(`the card is about ${card.root}, not the object shared (${root})`);
    }
  }
  const blocks = blocksOf(msg);
  const getBlock: GetBlock = async (cid) => {
    const inline = blocks.get(cid);
    if (inline !== undefined) {
      return inline;
    }
    const kept = held === undefined ? null : await held(cid);
    if (kept !== null) {
      blocks.set(cid, kept);
    }
    return kept;
  };
  const tree = await verifyTree(root, getBlock, { leaves: "optional" });
  if (!tree.files.has("index.json")) {
    throw new MalformedObjectError("format", "no index.json at the root");
  }
  if (tree.partial.has("index.json")) {
    throw new Error("object-share message carries no index.json: not the minimal share");
  }
  const files: TreeFiles = {};
  for (const path of tree.files.keys()) {
    if (path === "index.json" || (isInsideFiles(path) && !tree.partial.has(path))) {
      files[path] = (await resolvePath(root, path, getBlock)).bytes;
    }
  }
  const meta = parseIndex(files["index.json"] as Uint8Array);
  const object: FolderObject = { meta, tree: files };
  return { root, card, tree, object, complete: tree.missing.size === 0, blocks };
}

/**
 * The receiving side: a share that verifies has its blocks put in
 * `blobs/`; one that does not is left as it is in the log — a fact about
 * what arrived — and noted. Either way the record is there for the
 * application to show, which will run the same check to decide how. A
 * share whose leaves are not all here is a partial object, kept as far
 * as it goes: `blobs/` is by CID, so the rest fills in from wherever it
 * comes.
 */
export const objectShareHandler: ProtocolHandler = {
  types: [OBJECT_SHARE],

  async onInbound(record, contact, agent) {
    let share: VerifiedShare;
    try {
      share = await verifyShare(record.msg, (cid) => agent.vault.blobs.get(cid));
    } catch (err) {
      agent.log(`object from ${contact.name} does not verify: ${err instanceof Error ? err.message : err}`);
      return;
    }
    for (const [cid, bytes] of share.blocks) {
      await agent.vault.blobs.put(cid, bytes);
    }
    const who = share.card === null ? "unsigned" : `signed by ${share.card.did}`;
    const kept = `${share.tree.files.size} files kept`;
    const state = share.complete ? "" : `, ${share.tree.partial.size} awaiting ${missingBytes(share.tree)} bytes`;
    agent.log(`${share.object.meta.format} ${share.root} from ${contact.name} (${who}): ${kept}${state}`);
  },
};

/** The bytes a partial share still lacks, as the skeleton sizes them. */
export function missingBytes(tree: VerifiedTree): number {
  let total = 0;
  for (const size of tree.missing.values()) {
    total += size;
  }
  return total;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
