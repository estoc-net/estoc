import { v7 as uuidv7 } from "uuid";

import type { VaultBackend } from "../backend/types.js";
import { CONTACTS_DIR, prettyJson, text, utf8 } from "./layout.js";

/**
 * Contacts: mutable, low-cardinality records, one JSON file each. The
 * `cid` (uuidv7) is the anchor every other file refers to; the petname and
 * the DIDs are clothing that changes. A DID history is a chain with
 * evidence — a `from_prior` JWT signed by the old DID proves the hop — so
 * a message from any DID the contact ever used still finds its person.
 *
 * Files are named by cid — `contacts/<cid>.json` — so a record has one
 * home for life: renaming rewrites it in place, two petnames alike never
 * collide, and a `put` is a single write with nothing to clean up after.
 * The petname is inside the record, where it belongs.
 */

export interface DidUse {
  did: string;
  /** ISO time this DID came into use */
  from: string;
  /** ISO time it stopped, absent while current */
  until?: string;
  /** the from_prior JWT that announced this DID, when the contact rotated to it */
  fromPrior?: string;
}

/**
 * One of our DIDs toward a contact. The public DID may open the history
 * (a stranger wrote to it before we minted them a DID of their own); every
 * later entry is a pairwise did:peer:4 minted for this relationship alone.
 */
export interface MyDidUse {
  did: string;
  /** the keystore entry that derives this DID (`public`, or `pair/<cid>/<n>`) */
  key: string;
  /** ISO time this DID came into use toward them */
  from: string;
  /** ISO time it stopped, absent while current */
  until?: string;
  /** ISO time the mediator accepted it as a recipient; absent until it did */
  registeredAt?: string;
}

export interface ContactRecord {
  cid: string;
  /** petname: what we call them; free to change */
  name: string;
  createdAt: string;
  /** ISO time of the last `put`; absent on records written before it existed */
  updatedAt?: string;
  /** what they announced over user-profile/1.0 — a claim, never verified */
  claimedName?: string;
  /** their DIDs, oldest first; the one without `until` is current */
  dids: DidUse[];
  /** our DIDs toward them, oldest first; absent while we have never written to them */
  myDids?: MyDidUse[];
  /**
   * The DID of ours their latest envelope was sealed to — proven by our
   * having opened it. When it is not our current DID toward them, they
   * have not yet seen a rotation, and the next message out carries
   * `from_prior` until one comes back addressed to the new DID.
   */
  addressedAs?: string;
  /**
   * The id of the out-of-band invitation of theirs we accepted to meet
   * them, when that is how it began. They handed us a DID minted for us
   * alone, so we never knew them — nor they us — by anything public: our
   * first messages name the invitation as `pthid`, and no `from_prior` is
   * owed in either direction.
   */
  invitation?: string;
  /** ISO time our user-profile announcement went out to them */
  profileSharedAt?: string;
}

/** The DID a contact currently answers to. */
export function currentDid(contact: ContactRecord): string {
  for (let i = contact.dids.length - 1; i >= 0; i--) {
    const use = contact.dids[i] as DidUse;
    if (use.until === undefined) {
      return use.did;
    }
  }
  // Every DID has been closed out; the last one is still the best name.
  return (contact.dids[contact.dids.length - 1] as DidUse).did;
}

/** Our current DID toward a contact, or null while we have none. */
export function currentMyDid(contact: ContactRecord): MyDidUse | null {
  const uses = contact.myDids ?? [];
  for (let i = uses.length - 1; i >= 0; i--) {
    const use = uses[i] as MyDidUse;
    if (use.until === undefined) {
      return use;
    }
  }
  return null;
}

/**
 * The DID of ours toward a contact that the current one succeeded — the
 * latest closed entry — or null when there is none. When the contact has
 * never written to us, this is the DID they are likeliest to know us by.
 */
export function previousMyDid(contact: ContactRecord): MyDidUse | null {
  const uses = contact.myDids ?? [];
  for (let i = uses.length - 1; i >= 0; i--) {
    const use = uses[i] as MyDidUse;
    if (use.until !== undefined) {
      return use;
    }
  }
  return null;
}

/** The stand-in petname an auto-created contact carries until something names it. */
export function didPlaceholder(did: string): string {
  return did.length <= 30 ? did : `${did.slice(0, 20)}…${did.slice(-6)}`;
}

export function newContact(name: string, did: string, now = new Date()): ContactRecord {
  const at = now.toISOString();
  return {
    cid: uuidv7({ msecs: now.getTime() }),
    name,
    createdAt: at,
    updatedAt: at,
    dids: [{ did, from: at }],
  };
}

function isStringArrayish(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseContact(json: string, file: string): ContactRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${file} is not JSON: ${(err as Error).message}`);
  }
  const c = raw as Partial<ContactRecord> | null;
  if (typeof c !== "object" || c === null) {
    throw new Error(`${file} is not a contact record`);
  }
  if (typeof c.cid !== "string" || c.cid === "") {
    throw new Error(`${file} is missing a cid`);
  }
  if (typeof c.name !== "string" || typeof c.createdAt !== "string") {
    throw new Error(`${file} is missing name or createdAt`);
  }
  if (c.updatedAt !== undefined && typeof c.updatedAt !== "string") {
    throw new Error(`${file} has a malformed updatedAt`);
  }
  if (!isStringArrayish(c.dids) || c.dids.length === 0) {
    throw new Error(`${file} has no DID history`);
  }
  for (const use of c.dids as Partial<DidUse>[]) {
    if (typeof use?.did !== "string" || typeof use.from !== "string") {
      throw new Error(`${file} has a malformed DID history entry`);
    }
  }
  if (c.myDids !== undefined) {
    if (!isStringArrayish(c.myDids)) {
      throw new Error(`${file} has a malformed myDids`);
    }
    for (const use of c.myDids as Partial<MyDidUse>[]) {
      if (
        typeof use?.did !== "string" ||
        typeof use.from !== "string" ||
        typeof use.key !== "string"
      ) {
        throw new Error(`${file} has a malformed myDids entry`);
      }
    }
  }
  if (c.addressedAs !== undefined && typeof c.addressedAs !== "string") {
    throw new Error(`${file} has a malformed addressedAs`);
  }
  if (c.invitation !== undefined && typeof c.invitation !== "string") {
    throw new Error(`${file} has a malformed invitation`);
  }
  return c as ContactRecord;
}

/** The file a contact record lives in. */
export function contactFile(cid: string): string {
  return `${CONTACTS_DIR}/${cid}.json`;
}

export class ContactStore {
  private records: Map<string, ContactRecord> | null = null;

  constructor(private readonly backend: VaultBackend) {}

  /** Read every contact file once. */
  private async load(): Promise<Map<string, ContactRecord>> {
    if (this.records !== null) {
      return this.records;
    }
    const records = new Map<string, ContactRecord>();
    for (const file of await this.backend.list(CONTACTS_DIR)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const bytes = await this.backend.read(`${CONTACTS_DIR}/${file}`);
      if (bytes !== null) {
        const record = parseContact(text(bytes), file);
        records.set(record.cid, record);
      }
    }
    this.records = records;
    return records;
  }

  /** Every contact, in creation order (cids are time-ordered). */
  async all(): Promise<ContactRecord[]> {
    const records = await this.load();
    return [...records.values()]
      .sort((a, b) => (a.cid < b.cid ? -1 : 1))
      .map((record) => structuredClone(record));
  }

  async byCid(cid: string): Promise<ContactRecord | null> {
    const record = (await this.load()).get(cid);
    return record === undefined ? null : structuredClone(record);
  }

  /** The contact who has ever used `did`, current or historical. */
  async byDid(did: string): Promise<ContactRecord | null> {
    for (const record of (await this.load()).values()) {
      if (record.dids.some((use) => use.did === did)) {
        return structuredClone(record);
      }
    }
    return null;
  }

  /**
   * Create or replace the record with this cid — one write to its file.
   * Readers get copies and writers hand in copies: nothing you hold aliases
   * the cache, so a field changed without `put` is simply not saved —
   * never half-saved. `updatedAt` is stamped here — unless the caller is
   * relaying a record that already carries its own (a vault merge), where
   * restamping would make old news look newer than what it merges into.
   */
  async put(record: ContactRecord, options: { keepUpdatedAt?: boolean } = {}): Promise<void> {
    const records = await this.load();
    if (!options.keepUpdatedAt || record.updatedAt === undefined) {
      record.updatedAt = new Date().toISOString();
    }
    await this.backend.write(contactFile(record.cid), utf8(prettyJson(record)));
    records.set(record.cid, structuredClone(record));
  }

  async remove(cid: string): Promise<void> {
    const records = await this.load();
    if (!records.has(cid)) {
      return;
    }
    await this.backend.remove(contactFile(cid));
    records.delete(cid);
  }
}
