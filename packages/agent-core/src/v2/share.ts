/**
 * object-share/1.0, the giving side (docs/object-share.md §7–9): what a
 * share of ours is made of, and the package road past `maxShareBytes` —
 * the closure as one encrypted CAR at our mediator's blob store, and
 * the fetch that fills a received share in. The receiving side is the
 * handler's (`handlers/object-share.ts`, `keepShare`); the wire format
 * and the checks are `protocol/object-share.ts`, shared with v1.
 */

import type { BlobStore, Cid } from "@estoc/event-store";
import { blobHash, signRoot, verifyCard, type FolderObject } from "@estoc/folder-object";

import { BLOB_PUT, BLOB_PUT_RESULT, parsePutResult, type BlobPlacement } from "../protocol/blob-store.js";
import {
  attachmentsOf,
  closureOf,
  closureSize,
  openPackage,
  packageCar,
  packageParts,
  verifyShare,
  type Closure,
  type ObjectShareBody,
  type VerifiedShare,
} from "../protocol/object-share.js";
import { encryptStream, freshKey } from "../protocol/streaming-aead.js";
import type { PeerVault } from "./identity.js";
import type { MediatorLink } from "./link.js";
import type { MessageRecord } from "./records.js";
import type { TraceData } from "./trace.js";

/** A package of ours at the blob store: the ciphertext's name and key, kept so a second share of the same object reuses it. */
export interface PlacedPackage {
  hash: string;
  url: string;
  byteCount: number;
  key: Uint8Array;
  /** the store's hold as last told to us: a renewal moves it */
  retainUntil: string;
}

/** One line on the `wire` stream; resolves to its eid, or nothing when the trace could not be written — never throws. */
export type WireNote = (type: "wire.out" | "wire.in", data: TraceData) => Promise<string | undefined>;

/** What a share sends: the body naming root, card and package, the attachments, and the closure whose blocks the sender keeps. */
export interface ShareParts {
  body: ObjectShareBody;
  attachments: unknown[];
  closure: Closure;
}

/**
 * Build a share of `object` (§7): hash its canonical tree, and choose
 * the road — the whole closure as attachments when it fits
 * `maxShareBytes`, else the skeleton and `index.json` inline and the
 * closure placed as a package (`place`, §8), named in the body. An
 * object whose skeleton and `index.json` alone do not fit cannot be
 * shared this way. Plain, the share says only that we handed the
 * object over; with `sign` the anchor signs a card, with `card` the
 * card given must verify and name this very root — one card per share,
 * never both. The blocks are the caller's to keep, before the message
 * that names their root is recorded.
 */
export async function buildShare(
  opened: PeerVault,
  object: FolderObject,
  options: { sign?: boolean; card?: string },
  maxShareBytes: number,
  place: (closure: Closure) => Promise<PlacedPackage>
): Promise<ShareParts> {
  const closure = await closureOf(object.tree);
  const { root } = closure;
  const body: ObjectShareBody = { root };
  if (options.card !== undefined) {
    if (options.sign) {
      throw new Error("a share carries one card: either sign it or pass one on");
    }
    const given = await verifyCard(options.card);
    if (given.root !== root) {
      throw new Error(`the card is about ${given.root}, not this object (${root})`);
    }
    body.card = options.card;
  } else if (options.sign) {
    const anchor = opened.anchor;
    const identity = await opened.keys.derive(anchor.key);
    body.card = await signRoot(anchor.did, root, identity.signer);
  }
  let carried = closure.blocks;
  const attachments: unknown[] = [];
  if (closureSize(carried) > maxShareBytes) {
    carried = closure.minimal;
    const size = closureSize(carried);
    if (size > maxShareBytes) {
      throw new Error(`object's skeleton and index.json are ${size} bytes; one share carries at most ${maxShareBytes}`);
    }
    const { attachment, named } = packageParts(await place(closure));
    body.package = named;
    attachments.push(attachment);
  }
  return { body, attachments: [...attachmentsOf(carried), ...attachments], closure };
}

/**
 * The closure as a package at our mediator (§8.1): CAR it, encrypt it
 * under a fresh key, `put` its name and size (blob-store/1.0, over the
 * standing link — a ritual, bounded as any), and upload the bytes where
 * the mediator says — unless it has them. A package placed earlier this
 * run for the same root is put again (the hold is renewed) and reused
 * when the store still has its bytes, so sharing one object with
 * several contacts is one upload. The upload waits on no shared queue
 * and is bounded by `timeoutMs` alone.
 */
export async function placePackage(
  link: MediatorLink,
  packages: Map<Cid, PlacedPackage>,
  closure: Closure,
  fetchFn: typeof fetch,
  timeoutMs: number,
  note: WireNote,
  log: (line: string) => void
): Promise<PlacedPackage> {
  const known = packages.get(closure.root);
  if (known !== undefined) {
    const renewed = await putBlob(link, known.hash, known.byteCount);
    if (renewed.upload === null) {
      known.retainUntil = renewed.retainUntil;
      return known;
    }
  }
  const key = freshKey();
  const ciphertext = await encryptStream(key, packageCar(closure));
  const hash = await blobHash(ciphertext);
  const placed = await putBlob(link, hash, ciphertext.length);
  if (placed.upload !== null) {
    const out = await note("wire.out", { via: "http", method: "PUT", endpoint: placed.upload.url, bytes: ciphertext.length, what: "package" });
    const started = Date.now();
    const response = await fetchFn(placed.upload.url, { method: "PUT", body: ciphertext, signal: AbortSignal.timeout(timeoutMs) });
    void note("wire.in", { via: "http", parent: out, status: response.status, ms: Date.now() - started });
    if (!response.ok) {
      throw new Error(`the blob store answered ${response.status} to the package upload`);
    }
  }
  const result = { hash, url: placed.url, byteCount: ciphertext.length, key, retainUntil: placed.retainUntil };
  packages.set(closure.root, result);
  log(`package ${hash} (${ciphertext.length} bytes) placed at ${placed.url} until ${placed.retainUntil}`);
  return result;
}

/** blob-store/1.0 `put` to our mediator; a problem-report is an error naming its code. */
export async function putBlob(link: MediatorLink, hash: string, size: number): Promise<BlobPlacement> {
  const answer = await link.roundTrip(BLOB_PUT, { hash, size });
  const body = answer.body as Record<string, unknown>;
  if (answer.type !== BLOB_PUT_RESULT) {
    const code = typeof body.code === "string" ? body.code : answer.type;
    const comment = typeof body.comment === "string" ? `: ${body.comment}` : "";
    throw new Error(`the mediator will not keep the package (${code}${comment})`);
  }
  return parsePutResult(body);
}

/**
 * Fetch the package a received share names and fill the object in
 * (§8): GET the ciphertext, check it against its name, open it, and
 * walk the tree from the message's root over the package's blocks —
 * only blocks the walk reaches (the closure) are kept, put-if-absent
 * in `blobs/`. Resolves to the share as verified afterwards; throws
 * when the share's plaintext is gone, when it names no package, when
 * the bytes cannot be fetched (the store's retention ran out), or when
 * they do not open — the share is then what it was, a partial object.
 *
 * The share's `byte_count` is the contract for the download: a
 * response announcing more is refused before a byte is read, the body
 * is read no further than that many bytes, and fewer or more is not
 * the package. Redirects are not followed — the URL names the bytes,
 * and where it points was checked as it stands (`packageOf`).
 */
export async function fetchPackage(
  record: MessageRecord,
  blobs: BlobStore,
  fetchFn: typeof fetch,
  timeoutMs: number,
  note: WireNote,
  log: (line: string) => void
): Promise<VerifiedShare> {
  const msg = record.msg;
  if (msg === null) {
    throw new Error(`the share's plaintext is ${record.body}: nothing names the package`);
  }
  const before = await verifyShare(msg, (cid) => blobs.getBlock(cid));
  if (before.complete) {
    return before;
  }
  const pkg = before.package;
  if (pkg === null) {
    throw new Error(
      before.packageProblem === null
        ? "the share names no package to fetch"
        : `the share names a package this agent cannot use: ${before.packageProblem}`
    );
  }
  const out = await note("wire.out", { via: "http", method: "GET", endpoint: pkg.url, what: "package", mid: record.mid });
  const started = Date.now();
  const response = await fetchFn(pkg.url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  void note("wire.in", { via: "http", parent: out, status: response.status, bytes: pkg.byteCount, ms: Date.now() - started });
  if (!response.ok) {
    throw new Error(`the package is not there: ${pkg.url} answered ${response.status}`);
  }
  const ciphertext = await readExactly(response, pkg.byteCount);
  const blocks = await openPackage(pkg, ciphertext, before.root);
  const share = await verifyShare(msg, async (cid) => blocks.get(cid) ?? blobs.getBlock(cid));
  for (const [cid, bytes] of share.blocks) {
    await blobs.putBlock(cid, bytes);
  }
  log(`package ${pkg.hash} opened: ${share.root} is ${share.complete ? "whole" : "still partial"}`);
  return share;
}

/**
 * Read a response body that must be exactly `expected` bytes, without
 * ever holding more: a `Content-Length` saying otherwise is refused
 * before the body is read, and a body that runs past `expected` is
 * abandoned where it does. Fewer bytes than promised is an error too —
 * the share said how many, and the hash is over exactly those.
 */
async function readExactly(response: Response, expected: number): Promise<Uint8Array> {
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) !== expected) {
    throw new Error(`the package should be ${expected} bytes, the response announces ${announced}`);
  }
  if (response.body === null) {
    throw new Error("the package response has no body");
  }
  const out = new Uint8Array(expected);
  let got = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (got + value.length > expected) {
        throw new Error(`the package should be ${expected} bytes, the response keeps going`);
      }
      out.set(value, got);
      got += value.length;
    }
  } finally {
    reader.releaseLock();
    if (got !== expected) {
      await response.body.cancel().catch(() => undefined);
    }
  }
  if (got !== expected) {
    throw new Error(`the package should be ${expected} bytes, the response ended at ${got}`);
  }
  return out;
}
