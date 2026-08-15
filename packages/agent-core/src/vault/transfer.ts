import { parseSeedKeystore } from "@estoc/keystore";

import type { VaultBackend } from "../backend/types.js";
import { parseConfig } from "./config.js";
import { ContactStore, parseContact } from "./contacts.js";
import { InvitationStore, parseInvitationRecord } from "./invitations.js";
import {
  CONFIG_PATH,
  CONTACTS_DIR,
  INVITATIONS_DIR,
  KEYSTORE_PATH,
  MESSAGES_DIR,
  text,
  utf8,
} from "./layout.js";
import { MessageLog, parseSegment, type DamagedLine, type MessageRecord } from "./messages.js";

/**
 * Moving a vault between backends: the zip a browser exports, the folder a
 * device restores from. A snapshot is the vault's files, byte for byte, keyed
 * by their vault-relative paths (`.estoc/config.json`, …) — no conversion,
 * because the files *are* the format. Import lays a snapshot down over a
 * backend, and there the one interesting rule lives: **import merges, never
 * overwrites.**
 *
 *   - Into an empty backend it is a restore: every file as it was.
 *   - Into a vault of the same identity (same anchor DID) it is a merge:
 *     the snapshot's messages become a new log segment (minus the records
 *     already here — same `mid`, or the same wire message received twice),
 *     its contacts win by `updatedAt`, its invitations are added when
 *     missing (and marked taken when the snapshot knows who took one),
 *     and its config and keystore are left alone (same seed, and mediation
 *     is a fact about *this* device).
 *   - Into a vault of a different identity it is refused. Two identities are
 *     two vaults; blending their logs would misattribute every message.
 *
 * Nothing here decides *how* the files travel — zip, folder upload, a
 * paste of JSON — only what they mean once they arrive.
 */

/** Vault-relative path → bytes. */
export type VaultFiles = Record<string, Uint8Array>;

export type ImportOutcome =
  | { kind: "restored"; files: number }
  | {
      kind: "merged";
      messagesAdded: number;
      messagesSkipped: number;
      /** the new log segment, or null when nothing was new */
      segment: string | null;
      contactsAdded: number;
      contactsUpdated: number;
      contactsKept: number;
      invitationsAdded: number;
      damaged: DamagedLine[];
    };

/** Every file of the vault at `backend`, keyed by vault-relative path. */
export async function snapshotVault(backend: VaultBackend): Promise<VaultFiles> {
  const files: VaultFiles = {};
  for (const path of [CONFIG_PATH, KEYSTORE_PATH]) {
    const bytes = await backend.read(path);
    if (bytes !== null) {
      files[path] = bytes;
    }
  }
  for (const dir of [CONTACTS_DIR, INVITATIONS_DIR, MESSAGES_DIR]) {
    for (const name of (await backend.list(dir)).sort()) {
      const bytes = await backend.read(`${dir}/${name}`);
      if (bytes !== null) {
        files[`${dir}/${name}`] = bytes;
      }
    }
  }
  return files;
}

function nextSegment(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const match = /^(\d+)\.jsonl$/.exec(name);
    if (match !== null) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${String(max + 1).padStart(4, "0")}.jsonl`;
}

/** The two identities a record can carry: its local key, and the wire message it holds. */
function recordKeys(record: MessageRecord): [string, string] {
  return [
    `mid ${record.mid}`,
    `wire ${record.direction} ${record.sender ?? ""} ${record.msg.id}`,
  ];
}

/**
 * Lay `files` down over `backend`: restore into an empty backend, merge into
 * a vault of the same identity, refuse a different one. Throws before
 * writing anything if the snapshot is not a vault at all.
 */
export async function importVault(backend: VaultBackend, files: VaultFiles): Promise<ImportOutcome> {
  const configBytes = files[CONFIG_PATH];
  if (configBytes === undefined) {
    throw new Error("not a vault: no .estoc/config.json inside");
  }
  const incoming = parseConfig(text(configBytes));
  const keystoreBytes = files[KEYSTORE_PATH];
  if (keystoreBytes === undefined) {
    throw new Error("not a vault: no .estoc/keystore.json inside");
  }
  parseSeedKeystore(text(keystoreBytes));

  const localConfigBytes = await backend.read(CONFIG_PATH);
  if (localConfigBytes === null) {
    // restore: the files as they were, config last so a crash midway
    // leaves "no vault" rather than a vault missing pieces
    const paths = Object.keys(files).filter((path) => path !== CONFIG_PATH);
    for (const path of paths) {
      await backend.write(path, files[path] as Uint8Array);
    }
    await backend.write(CONFIG_PATH, configBytes);
    return { kind: "restored", files: paths.length + 1 };
  }

  const local = parseConfig(text(localConfigBytes));
  if (local.identity.anchor.did !== incoming.identity.anchor.did) {
    throw new Error(
      `that vault belongs to a different identity (${incoming.identity.anchor.did}); ` +
        `this one is ${local.identity.anchor.did}`
    );
  }

  // messages: whatever is not already here goes into one new segment
  const damaged: DamagedLine[] = [];
  const seen = new Set<string>();
  for (const record of await new MessageLog(backend).read((d) => damaged.push(d))) {
    for (const key of recordKeys(record)) {
      seen.add(key);
    }
  }
  const fresh: MessageRecord[] = [];
  let messagesSkipped = 0;
  const incomingSegments = Object.keys(files)
    .filter((path) => path.startsWith(`${MESSAGES_DIR}/`) && path.endsWith(".jsonl"))
    .sort();
  for (const path of incomingSegments) {
    const name = path.slice(MESSAGES_DIR.length + 1);
    const records = parseSegment(text(files[path] as Uint8Array), name, (d) => damaged.push(d));
    for (const record of records) {
      const keys = recordKeys(record);
      if (keys.some((key) => seen.has(key))) {
        messagesSkipped += 1;
        continue;
      }
      for (const key of keys) {
        seen.add(key);
      }
      fresh.push(record);
    }
  }
  let segment: string | null = null;
  if (fresh.length > 0) {
    segment = nextSegment(await backend.list(MESSAGES_DIR));
    await backend.write(
      `${MESSAGES_DIR}/${segment}`,
      utf8(fresh.map((record) => JSON.stringify(record)).join("\n") + "\n")
    );
  }

  // contacts: by cid, the later updatedAt wins; a tie keeps ours
  const contacts = new ContactStore(backend);
  let contactsAdded = 0;
  let contactsUpdated = 0;
  let contactsKept = 0;
  const incomingContacts = Object.keys(files)
    .filter((path) => path.startsWith(`${CONTACTS_DIR}/`) && path.endsWith(".json"))
    .sort();
  for (const path of incomingContacts) {
    const name = path.slice(CONTACTS_DIR.length + 1);
    const record = parseContact(text(files[path] as Uint8Array), name);
    const mine = await contacts.byCid(record.cid);
    if (mine === null) {
      await contacts.put(record, { keepUpdatedAt: true });
      contactsAdded += 1;
    } else if ((record.updatedAt ?? "") > (mine.updatedAt ?? "")) {
      await contacts.put(record, { keepUpdatedAt: true });
      contactsUpdated += 1;
    } else {
      contactsKept += 1;
    }
  }

  // invitations: by id; one this vault has open that the snapshot knows
  // to be taken becomes taken here too — the DID is spent either way
  const invitations = new InvitationStore(backend);
  let invitationsAdded = 0;
  const incomingInvitations = Object.keys(files)
    .filter((path) => path.startsWith(`${INVITATIONS_DIR}/`) && path.endsWith(".json"))
    .sort();
  for (const path of incomingInvitations) {
    const name = path.slice(INVITATIONS_DIR.length + 1);
    const record = parseInvitationRecord(text(files[path] as Uint8Array), name);
    const mine = await invitations.byId(record.id);
    if (mine === null) {
      await invitations.put(record);
      invitationsAdded += 1;
    } else if (mine.acceptedBy === undefined && record.acceptedBy !== undefined) {
      await invitations.put({ ...mine, ...record });
    }
  }

  return {
    kind: "merged",
    messagesAdded: fresh.length,
    messagesSkipped,
    segment,
    contactsAdded,
    contactsUpdated,
    contactsKept,
    invitationsAdded,
    damaged,
  };
}
