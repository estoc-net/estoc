import {
  createCard,
  hashTree,
  verifyCard,
  verifyTree,
  isDagPbCid,
  type CardSigner,
  type RootCard,
  type TreeFiles,
  type VerifiedTree,
} from "@estoc/signed-dir";
import { publicKeyFromDidKey } from "@estoc/keystore";

import type { PlainMessage } from "../vault/messages.js";
import type { ProtocolHandler } from "./handler.js";

/**
 * object-share/1.0 (`docs/object-share.md`): hand a contact a whole
 * object — a folder hashed into a UnixFS tree and vouched for by a root
 * card. One message carries the closure: the card in the body, every
 * block as an attachment named by its CID. Nothing is fetched, nothing
 * is asked back; the receiver either holds the entire tree once the
 * message is read or holds none of it.
 *
 * The card is testimony about the tree, not about the message: its `did`
 * is whoever signed — the sender's own anchor for something they made,
 * or the original author's when the sender passes a bundle on. The
 * envelope proves who sent; the card proves who stands behind the bytes.
 */
export const OBJECT_SHARE = "https://estoc.dev/object-share/1.0/share";

/** IPLD block media types, as the IPFS ecosystem names them. */
export const DAG_PB_MEDIA_TYPE = "application/vnd.ipld.dag-pb";
export const RAW_MEDIA_TYPE = "application/vnd.ipld.raw";

/** The raw block bytes one share may carry by default: what a mediator queue comfortably holds. */
export const DEFAULT_MAX_SHARE_BYTES = 1024 * 1024;

export interface ObjectShareBody {
  /** compact JWS over `{did, root}` — signed-dir's root card */
  card: string;
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

/** The closure of a tree: its root and every block the root reaches, CID → bytes. */
export interface Closure {
  root: string;
  blocks: Map<string, Uint8Array>;
}

/** What a verified share yields: whose tree, which root, what is in it, and the bytes. */
export interface VerifiedShare {
  card: RootCard;
  tree: VerifiedTree;
  blocks: Map<string, Uint8Array>;
}

/**
 * Hash a folder and gather the complete object set: signed-dir's `nodes`
 * plus the input bytes of every single-block file (which `hashTree`
 * deliberately does not copy).
 */
export async function closureOf(files: TreeFiles): Promise<Closure> {
  const hashed = await hashTree(files);
  const blocks = new Map(hashed.nodes);
  for (const [cid, path] of hashed.files) {
    if (!blocks.has(cid)) {
      blocks.set(cid, files[path] as Uint8Array);
    }
  }
  return { root: hashed.root, blocks };
}

/** The bytes of a closure, summed. */
export function closureSize(blocks: Map<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of blocks.values()) {
    total += bytes.length;
  }
  return total;
}

/** A did:key's one verification method, `did:key:z6Mk…#z6Mk…`. */
export function didKeyKid(did: string): string {
  if (!did.startsWith("did:key:")) {
    throw new Error("cards are signed by did:key identities");
  }
  return `${did}#${did.slice("did:key:".length)}`;
}

/** Sign a root card as `did` (a did:key) over `root`. */
export function signCard(did: string, root: string, signer: CardSigner): Promise<string> {
  return createCard({ did, root }, signer, didKeyKid(did));
}

/**
 * Verify a did:key root card: the JWS checks out under the key the
 * payload's DID names. Throws on anything else.
 */
export async function verifyDidKeyCard(jws: string): Promise<RootCard> {
  const { card, kid } = await verifyCard(jws, (kid) => {
    const did = kid.split("#")[0] ?? "";
    if (!did.startsWith("did:key:") || didKeyKid(did) !== kid) {
      return null;
    }
    return publicKeyFromDidKey(did);
  });
  if (didKeyKid(card.did) !== kid) {
    throw new Error("the card's kid does not belong to the card's did");
  }
  return card;
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
 * Check a share message end to end: the card verifies under its own
 * did:key, and the blocks carried reach every path under the card's
 * root with matching hashes. Throws naming the first thing wrong.
 */
export async function verifyShare(msg: PlainMessage): Promise<VerifiedShare> {
  const body = msg.body as Partial<ObjectShareBody>;
  if (typeof body.card !== "string") {
    throw new Error("object-share message has no card");
  }
  const card = await verifyDidKeyCard(body.card);
  const blocks = blocksOf(msg);
  const tree = await verifyTree(card.root, blocks);
  return { card, tree, blocks };
}

/**
 * The receiving side: a share that verifies has its blocks put in
 * `blobs/`; one that does not is left as it is in the log — a fact about
 * what arrived — and noted. Either way the record is there for the
 * application to show, which will run the same check to decide how.
 */
export const objectShareHandler: ProtocolHandler = {
  types: [OBJECT_SHARE],

  async onInbound(record, contact, agent) {
    let share: VerifiedShare;
    try {
      share = await verifyShare(record.msg);
    } catch (err) {
      agent.log(`object from ${contact.name} does not verify: ${err instanceof Error ? err.message : err}`);
      return;
    }
    for (const [cid, bytes] of share.blocks) {
      await agent.vault.blobs.put(cid, bytes);
    }
    agent.log(`object ${share.card.root} from ${contact.name} (signed by ${share.card.did}): ${share.tree.files.size} files kept`);
  },
};

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
