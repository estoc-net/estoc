import type { VaultBackend } from "../backend/types.js";
import { INVITATIONS_DIR, prettyJson, text, utf8 } from "./layout.js";

/**
 * Invitations: the single-use out-of-band/2.0 invitations this vault has
 * issued, one JSON file each under `invitations/<id>.json`. An invitation
 * is a DID minted for nobody in particular yet — the first person to
 * write to it takes it, and from then on that DID is ours toward them
 * (it moves into their contact record's `myDids`, and the invitation is
 * marked `acceptedBy`). Its life is unlike a contact's — waiting, taken,
 * revoked — which is why it is not a contact with a blank name.
 */

export interface InvitationRecord {
  /** the out-of-band message id; the answer names it as `pthid` */
  id: string;
  /** the keystore entry that derives the DID: `invite/<id>` */
  key: string;
  /** the did:peer:4 the invitation hands out — the mediator's routing DID as its service */
  did: string;
  createdAt: string;
  /** what the invitation says it is for, in words for the person opening it */
  goal: string;
  /** ISO time the mediator accepted the DID as a recipient; absent until it did */
  registeredAt?: string;
  /** the cid of the contact who answered it, once someone has */
  acceptedBy?: string;
  acceptedAt?: string;
}

/** An invitation nobody has answered yet. */
export function isOpenInvitation(invitation: InvitationRecord): boolean {
  return invitation.acceptedBy === undefined;
}

export function parseInvitationRecord(json: string, file: string): InvitationRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${file} is not JSON: ${(err as Error).message}`);
  }
  const r = raw as Partial<InvitationRecord> | null;
  if (typeof r !== "object" || r === null) {
    throw new Error(`${file} is not an invitation record`);
  }
  for (const field of ["id", "key", "did", "createdAt", "goal"] as const) {
    if (typeof r[field] !== "string" || r[field] === "") {
      throw new Error(`${file} is missing ${field}`);
    }
  }
  for (const field of ["registeredAt", "acceptedBy", "acceptedAt"] as const) {
    if (r[field] !== undefined && typeof r[field] !== "string") {
      throw new Error(`${file} has a malformed ${field}`);
    }
  }
  return r as InvitationRecord;
}

/** A file-name-safe form of an id; ids are UUIDs, so this is a guard, not a transform. */
function fileOf(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

export class InvitationStore {
  private records: Map<string, InvitationRecord> | null = null;

  constructor(private readonly backend: VaultBackend) {}

  private async load(): Promise<Map<string, InvitationRecord>> {
    if (this.records !== null) {
      return this.records;
    }
    const records = new Map<string, InvitationRecord>();
    for (const file of await this.backend.list(INVITATIONS_DIR)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const bytes = await this.backend.read(`${INVITATIONS_DIR}/${file}`);
      if (bytes === null) {
        continue;
      }
      const record = parseInvitationRecord(text(bytes), file);
      records.set(record.id, record);
    }
    this.records = records;
    return records;
  }

  /** Every invitation, oldest first. */
  async all(): Promise<InvitationRecord[]> {
    const records = await this.load();
    return [...records.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((record) => structuredClone(record));
  }

  async byId(id: string): Promise<InvitationRecord | null> {
    const record = (await this.load()).get(id);
    return record === undefined ? null : structuredClone(record);
  }

  async byDid(did: string): Promise<InvitationRecord | null> {
    for (const record of (await this.load()).values()) {
      if (record.did === did) {
        return structuredClone(record);
      }
    }
    return null;
  }

  /** Create or replace; as with contacts, what you hold is a copy until `put`. */
  async put(record: InvitationRecord): Promise<void> {
    const records = await this.load();
    await this.backend.write(`${INVITATIONS_DIR}/${fileOf(record.id)}`, utf8(prettyJson(record)));
    records.set(record.id, structuredClone(record));
  }

  async remove(id: string): Promise<void> {
    const records = await this.load();
    if (!records.has(id)) {
      return;
    }
    await this.backend.remove(`${INVITATIONS_DIR}/${fileOf(id)}`);
    records.delete(id);
  }
}
