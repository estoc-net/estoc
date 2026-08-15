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
 * File names are a readable handle derived from the petname; the record
 * inside is the truth. Renaming moves the file, and a name that collides
 * with another contact's file gets a cid suffix — the directory stays
 * greppable without ever being the source of identity.
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
  return c as ContactRecord;
}

/** A file-name-safe handle for a petname; never empty. */
export function contactFileStem(name: string): string {
  const stem = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 64);
  return stem === "" ? "contact" : stem;
}

export class ContactStore {
  /** cid → file name, once loaded */
  private files: Map<string, string> | null = null;
  private records = new Map<string, ContactRecord>();

  constructor(private readonly backend: VaultBackend) {}

  /**
   * Read every contact file once. Two files carrying the same cid are the
   * residue of a rename that crashed between writing the new file and
   * removing the old (see `put`): the later `updatedAt` is the survivor,
   * the other file is dropped here — the store heals on open rather than
   * refusing to.
   */
  private async load(): Promise<Map<string, string>> {
    if (this.files !== null) {
      return this.files;
    }
    const files = new Map<string, string>();
    for (const file of await this.backend.list(CONTACTS_DIR)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const bytes = await this.backend.read(`${CONTACTS_DIR}/${file}`);
      if (bytes === null) {
        continue;
      }
      const record = parseContact(text(bytes), file);
      const rival = this.records.get(record.cid);
      if (rival !== undefined) {
        const rivalFile = files.get(record.cid) as string;
        const keepNew = (record.updatedAt ?? "") > (rival.updatedAt ?? "");
        await this.backend.remove(`${CONTACTS_DIR}/${keepNew ? rivalFile : file}`);
        if (!keepNew) {
          continue;
        }
      }
      files.set(record.cid, file);
      this.records.set(record.cid, record);
    }
    this.files = files;
    return files;
  }

  /** Every contact, in creation order (cids are time-ordered). */
  async all(): Promise<ContactRecord[]> {
    await this.load();
    return [...this.records.values()]
      .sort((a, b) => (a.cid < b.cid ? -1 : 1))
      .map((record) => structuredClone(record));
  }

  async byCid(cid: string): Promise<ContactRecord | null> {
    await this.load();
    const record = this.records.get(cid);
    return record === undefined ? null : structuredClone(record);
  }

  /** The contact who has ever used `did`, current or historical. */
  async byDid(did: string): Promise<ContactRecord | null> {
    await this.load();
    for (const record of this.records.values()) {
      if (record.dids.some((use) => use.did === did)) {
        return structuredClone(record);
      }
    }
    return null;
  }

  /**
   * Create or replace the record with this cid; the file follows the name.
   * Readers get copies and writers hand in copies: nothing you hold aliases
   * the cache, so a field changed without `put` is simply not saved —
   * never half-saved. `updatedAt` is stamped here — unless the caller is
   * relaying a record that already carries its own (a vault merge), where
   * restamping would make old news look newer than what it merges into.
   */
  async put(record: ContactRecord, options: { keepUpdatedAt?: boolean } = {}): Promise<void> {
    const files = await this.load();
    if (!options.keepUpdatedAt || record.updatedAt === undefined) {
      record.updatedAt = new Date().toISOString();
    }
    const previous = files.get(record.cid);
    const stem = contactFileStem(record.name);
    let file = `${stem}.json`;
    const taken = [...files.entries()].some(
      ([cid, name]) => cid !== record.cid && name === file
    );
    if (taken) {
      file = `${stem}-${record.cid.slice(0, 8)}.json`;
    }
    await this.backend.write(`${CONTACTS_DIR}/${file}`, utf8(prettyJson(record)));
    if (previous !== undefined && previous !== file) {
      // rename: the new file is already down, so a crash here leaves two
      // files with one cid, which `load` resolves by updatedAt
      await this.backend.remove(`${CONTACTS_DIR}/${previous}`);
    }
    files.set(record.cid, file);
    this.records.set(record.cid, structuredClone(record));
  }

  async remove(cid: string): Promise<void> {
    const files = await this.load();
    const file = files.get(cid);
    if (file === undefined) {
      return;
    }
    await this.backend.remove(`${CONTACTS_DIR}/${file}`);
    files.delete(cid);
    this.records.delete(cid);
  }
}
