/**
 * The vault's event types (vault-events.md): what `data` holds under each
 * `type`, and a reader that tells a line of one of these types from a
 * line that only claims to be. The store knows none of these names
 * (event-store.md §2); this is the first layer that does.
 *
 * Every type here is a `type` alias and not an interface, so that it is
 * a `JsonObject` to the store's `Event<D>`.
 */

import type { Cid, Event, JsonObject, JsonValue } from "@estoc/event-store";
import { isCid, isDeviceId, isUuidv7 } from "@estoc/event-store";

// ---- channels (§3) ---------------------------------------------------------

/** One key of ours and one key of theirs (§3): every observation carries both, `null` a value. */
export type ChannelKey = {
  /** the name of a key of ours (§2); null: no key of ours was involved */
  myKey: string | null;
  /** the fingerprint of a public key of theirs (`peerKeyOf`); null: the sender is anonymous */
  peerKey: string | null;
};

export type EnvelopeKind = "authcrypt" | "anoncrypt" | "signed";

export type ChannelFirstSeen = ChannelKey & {
  /** the peer's full public key, as a did:key or multibase; absent when `peerKey` is null */
  peerPublicKey?: string;
  kind: EnvelopeKind;
  /** the DID the key wore when first seen; absent when there was none */
  firstDid?: string;
};

/** The skeleton of a message (§3.1): what a thread view needs and nothing a person said. */
export type Skeleton = ChannelKey & {
  mid: string;
  wireId: string;
  msgType: string;
  thid?: string;
  pthid?: string;
  /** the size of the plaintext */
  bytes: number;
  /** the root of the blob holding the plaintext (§4) */
  body: Cid;
  /** the roots of every blob lifted out of it */
  attachments: Cid[];
};

export type MessageIn = Skeleton & {
  /** a signature that rode inside the encryption */
  signedBy?: string;
};

export type MessageOut = Skeleton;

export type DeliveryOutcome = "sent" | "failed";

export type DeliveryAttempted = ChannelKey & {
  mid: string;
  attempt: number;
  outcome: DeliveryOutcome;
  error?: string;
};

export type DeliveryHeld = ChannelKey & { mid: string; because: "user" | "imported" };

export type ProfileNameClaimed = ChannelKey & { mid: string; name: string };

export type ProfileShared = ChannelKey & { mid: string };

export type PeerResolved = ChannelKey & {
  did: string;
  /** every key the document listed, as did:key or multibase: context, never an edge (§7.1) */
  keys: string[];
  service?: string | null;
};

export type PeerRotated = ChannelKey & {
  from: string;
  to: string;
  fromPrior: string;
  mid: string;
};

export type EraseCause = "user" | "contact-deleted";

export type MessageErased = ChannelKey & {
  mid: string;
  /** roots: the body, some or all attachments */
  drop: Cid[];
  because: EraseCause;
};

// ---- identity and devices (§5) ---------------------------------------------

export type DeviceMinted = Record<string, never>;

export type DidMinted = {
  key: string;
  did: string;
  /** the routing DID in its service; null for a DID only ever picked up from */
  routingDid: string | null;
  /** which device's mediation the routing DID came from; null with a null `routingDid` */
  mediation: string | null;
};

export type DidRegistered = { key: string };

export type PublishedAs = "oob" | "profile";
export type Uses = "one" | "many";

export type DidPublished = {
  key: string;
  as: PublishedAs;
  uses: Uses;
  oobId?: string;
  goal?: string;
};

export type DidRetired = { key: string; because: string };

export type MediationCreated = {
  id: string;
  mediatorDid: string;
  me: { key: string; did: string };
};

export type MediationGranted = { id: string; routingDid: string };

export type MediationRetired = { id: string; because: string };

export type IdentityLabel = { name: string };

export type DeviceLabel = { dev: string; name: string };

export type DeviceRetired = { dev: string; because: string };

export type ExtensionInstalled = {
  ext: string;
  name: string;
  /** provisional: the root of a signed object — a name, never a reference */
  object?: string;
};

export type ExtensionRemoved = { ext: string };

export type ExtensionPurged = { ext: string };

// ---- contacts (§6) ---------------------------------------------------------

export type ContactCreated = { cid: string };

export type ContactPetname = { cid: string; name: string };

/** `cid` and any number of boolean flags, each latest-wins on its own. */
export type ContactFlag = { cid: string; [flag: string]: string | boolean };

export type ContactUseKey = { cid: string; key: string; because: string };

export type AttachCause = "invitation" | "accepted" | "manual";

export type ContactAttached = ChannelKey & { cid: string; because: AttachCause; oobId?: string };

export type ContactDetached = ChannelKey & { cid: string };

export type ContactMerged = { cid: string; from: string };

export type ContactDeleted = { cid: string };

// ---- the types, by name ----------------------------------------------------

/** `data` by `type`: the vault's own types, and what each line of them carries. */
export type VaultData = {
  "channel.firstSeen": ChannelFirstSeen;
  "message.in": MessageIn;
  "message.out": MessageOut;
  "delivery.attempted": DeliveryAttempted;
  "delivery.held": DeliveryHeld;
  "profile.nameClaimed": ProfileNameClaimed;
  "profile.shared": ProfileShared;
  "peer.resolved": PeerResolved;
  "peer.rotated": PeerRotated;
  "message.erased": MessageErased;
  "device.minted": DeviceMinted;
  "did.minted": DidMinted;
  "did.registered": DidRegistered;
  "did.published": DidPublished;
  "did.retired": DidRetired;
  "mediation.created": MediationCreated;
  "mediation.granted": MediationGranted;
  "mediation.retired": MediationRetired;
  "identity.label": IdentityLabel;
  "device.label": DeviceLabel;
  "device.retired": DeviceRetired;
  "extension.installed": ExtensionInstalled;
  "extension.removed": ExtensionRemoved;
  "extension.purged": ExtensionPurged;
  "contact.created": ContactCreated;
  "contact.petname": ContactPetname;
  "contact.flag": ContactFlag;
  "contact.useKey": ContactUseKey;
  "contact.attached": ContactAttached;
  "contact.detached": ContactDetached;
  "contact.merged": ContactMerged;
  "contact.deleted": ContactDeleted;
};

export type VaultType = keyof VaultData;

/** An event of one of the vault's types, `data` read. */
export type VaultEvent<T extends VaultType = VaultType> = T extends VaultType ? Event<VaultData[T]> & { type: T } : never;

/** The observations (§3.1): every one carries a `ChannelKey`. */
export const OBSERVATIONS = [
  "channel.firstSeen",
  "message.in",
  "message.out",
  "delivery.attempted",
  "profile.nameClaimed",
  "profile.shared",
  "peer.resolved",
  "peer.rotated",
] as const satisfies readonly VaultType[];

/** The two decisions that carry a pair, because they are about one message in it (§3.1). */
export const CHANNEL_DECISIONS = ["delivery.held", "message.erased"] as const satisfies readonly VaultType[];

export function isVaultType(type: string): type is VaultType {
  return Object.hasOwn(READERS, type);
}

/** The key names of §2: `anchor`, `mediation/<id>/me`, `did/<id>`. */
export const KEY_ANCHOR = "anchor";
export const DID_KEY_PREFIX = "did/";
export const MEDIATION_KEY_PREFIX = "mediation/";

export function didKeyName(id: string): string {
  return `${DID_KEY_PREFIX}${id}`;
}

export function mediationKeyName(id: string): string {
  return `${MEDIATION_KEY_PREFIX}${id}/me`;
}

/** A `mediation/<id>/me` key: the mediator's channels, not any contact's (§3). */
export function isMediationKey(name: string | null): boolean {
  return name !== null && name.startsWith(MEDIATION_KEY_PREFIX);
}

/** Two pairs name one channel. */
export function sameChannel(a: ChannelKey, b: ChannelKey): boolean {
  return a.myKey === b.myKey && a.peerKey === b.peerKey;
}

/** A pair as a map key; not a format, not written anywhere (§3: no channel id). */
export function channelId(pair: ChannelKey): string {
  return JSON.stringify([pair.myKey, pair.peerKey]);
}

// ---- reading ---------------------------------------------------------------

/** A line of one of the vault's types whose `data` is not what the type says. */
export class Malformed extends Error {
  constructor(
    readonly event: Event,
    readonly why: string
  ) {
    super(`${event.type} ${event.eid}: ${why}`);
    this.name = "Malformed";
  }
}

type Reader<T extends VaultType> = (data: JsonObject) => VaultData[T];

class Check {
  constructor(private readonly data: JsonObject) {}

  private get(field: string): JsonValue | undefined {
    return Object.hasOwn(this.data, field) ? this.data[field] : undefined;
  }

  str(field: string): string {
    const value = this.get(field);
    if (typeof value !== "string" || value === "") {
      throw `${field} is not a non-empty string`;
    }
    return value;
  }

  optStr(field: string): string | undefined {
    const value = this.get(field);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw `${field} is not a string`;
    }
    return value;
  }

  nullableStr(field: string): string | null {
    const value = this.get(field);
    if (value === null) {
      return null;
    }
    if (typeof value !== "string" || value === "") {
      throw `${field} is not a non-empty string or null`;
    }
    return value;
  }

  oneOf<V extends string>(field: string, values: readonly V[]): V {
    const value = this.str(field);
    if (!(values as readonly string[]).includes(value)) {
      throw `${field} is not one of ${values.join(", ")}`;
    }
    return value as V;
  }

  int(field: string, min: number): number {
    const value = this.get(field);
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
      throw `${field} is not an integer ≥ ${min}`;
    }
    return value;
  }

  strings(field: string): string[] {
    const value = this.get(field);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw `${field} is not a list of strings`;
    }
    return value as string[];
  }

  cid(field: string): Cid {
    const value = this.str(field);
    if (!isCid(value)) {
      throw `${field} is not a profile CID`;
    }
    return value;
  }

  cids(field: string): Cid[] {
    const value = this.strings(field);
    if (!value.every(isCid)) {
      throw `${field} holds a name that is not a profile CID`;
    }
    return value;
  }

  uuid(field: string): string {
    const value = this.str(field);
    if (!isUuidv7(value)) {
      throw `${field} is not a uuidv7`;
    }
    return value;
  }

  dev(field: string): string {
    const value = this.str(field);
    if (!isDeviceId(value)) {
      throw `${field} is not a device id`;
    }
    return value;
  }

  key(field: string): string {
    const value = this.str(field);
    if (!KEY_NAME.test(value)) {
      throw `${field} is not a key name`;
    }
    return value;
  }

  channel(): ChannelKey {
    const myKey = this.nullableStr("myKey");
    if (myKey !== null && !KEY_NAME.test(myKey)) {
      throw "myKey is not a key name";
    }
    const peerKey = this.nullableStr("peerKey");
    if (peerKey !== null && !PEER_KEY.test(peerKey)) {
      throw "peerKey is not a fingerprint";
    }
    return { myKey, peerKey };
  }

  /** every boolean field but `cid`: a flag each */
  flags(): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const [field, value] of Object.entries(this.data)) {
      if (field === "cid") {
        continue;
      }
      if (typeof value !== "boolean") {
        throw `${field} is not a boolean flag`;
      }
      flags[field] = value;
    }
    return flags;
  }
}

/** A key name as `@estoc/keystore` v3 has it (§2). */
export const KEY_NAME = /^[A-Za-z0-9._/-]+$/;
/** A peer key: 26 characters of base32 lower (§3). */
export const PEER_KEY = /^[a-z2-7]{26}$/;

function optional<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  const out: Partial<T> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out as T;
}

function skeleton(c: Check): Skeleton {
  return {
    ...c.channel(),
    mid: c.uuid("mid"),
    wireId: c.str("wireId"),
    msgType: c.str("msgType"),
    ...optional({ thid: c.optStr("thid"), pthid: c.optStr("pthid") }),
    bytes: c.int("bytes", 0),
    body: c.cid("body"),
    attachments: c.cids("attachments"),
  };
}

const READERS: { [T in VaultType]: Reader<T> } = {
  "channel.firstSeen": (data) => {
    const c = new Check(data);
    const pair = c.channel();
    const peerPublicKey = c.optStr("peerPublicKey");
    if ((peerPublicKey === undefined) !== (pair.peerKey === null)) {
      throw "peerPublicKey is present exactly when peerKey is";
    }
    return { ...pair, ...optional({ peerPublicKey, firstDid: c.optStr("firstDid") }), kind: c.oneOf("kind", ["authcrypt", "anoncrypt", "signed"]) };
  },
  "message.in": (data) => {
    const c = new Check(data);
    return { ...skeleton(c), ...optional({ signedBy: c.optStr("signedBy") }) };
  },
  "message.out": (data) => skeleton(new Check(data)),
  "delivery.attempted": (data) => {
    const c = new Check(data);
    return { ...c.channel(), mid: c.uuid("mid"), attempt: c.int("attempt", 1), outcome: c.oneOf("outcome", ["sent", "failed"]), ...optional({ error: c.optStr("error") }) };
  },
  "delivery.held": (data) => {
    const c = new Check(data);
    return { ...c.channel(), mid: c.uuid("mid"), because: c.oneOf("because", ["user", "imported"]) };
  },
  "profile.nameClaimed": (data) => {
    const c = new Check(data);
    return { ...c.channel(), mid: c.uuid("mid"), name: c.str("name") };
  },
  "profile.shared": (data) => {
    const c = new Check(data);
    return { ...c.channel(), mid: c.uuid("mid") };
  },
  "peer.resolved": (data) => {
    const c = new Check(data);
    const service = Object.hasOwn(data, "service") ? c.nullableStr("service") : undefined;
    return { ...c.channel(), did: c.str("did"), keys: c.strings("keys"), ...optional({ service }) };
  },
  "peer.rotated": (data) => {
    const c = new Check(data);
    return { ...c.channel(), from: c.str("from"), to: c.str("to"), fromPrior: c.str("fromPrior"), mid: c.uuid("mid") };
  },
  "message.erased": (data) => {
    const c = new Check(data);
    return { ...c.channel(), mid: c.uuid("mid"), drop: c.cids("drop"), because: c.oneOf("because", ["user", "contact-deleted"]) };
  },
  "device.minted": (data) => {
    if (Object.keys(data).length !== 0) {
      throw "data is not empty";
    }
    return {};
  },
  "did.minted": (data) => {
    const c = new Check(data);
    const routingDid = c.nullableStr("routingDid");
    const mediation = c.nullableStr("mediation");
    if (routingDid === null && mediation !== null) {
      throw "mediation names a mediation but routingDid is null";
    }
    return { key: c.key("key"), did: c.str("did"), routingDid, mediation };
  },
  "did.registered": (data) => ({ key: new Check(data).key("key") }),
  "did.published": (data) => {
    const c = new Check(data);
    return { key: c.key("key"), as: c.oneOf("as", ["oob", "profile"]), uses: c.oneOf("uses", ["one", "many"]), ...optional({ oobId: c.optStr("oobId"), goal: c.optStr("goal") }) };
  },
  "did.retired": (data) => {
    const c = new Check(data);
    return { key: c.key("key"), because: c.str("because") };
  },
  "mediation.created": (data) => {
    const c = new Check(data);
    const me = data["me"];
    if (typeof me !== "object" || me === null || Array.isArray(me)) {
      throw "me is not an object";
    }
    const m = new Check(me);
    return { id: c.uuid("id"), mediatorDid: c.str("mediatorDid"), me: { key: m.key("key"), did: m.str("did") } };
  },
  "mediation.granted": (data) => {
    const c = new Check(data);
    return { id: c.uuid("id"), routingDid: c.str("routingDid") };
  },
  "mediation.retired": (data) => {
    const c = new Check(data);
    return { id: c.uuid("id"), because: c.str("because") };
  },
  "identity.label": (data) => ({ name: new Check(data).str("name") }),
  "device.label": (data) => {
    const c = new Check(data);
    return { dev: c.dev("dev"), name: c.str("name") };
  },
  "device.retired": (data) => {
    const c = new Check(data);
    return { dev: c.dev("dev"), because: c.str("because") };
  },
  "extension.installed": (data) => {
    const c = new Check(data);
    return { ext: c.uuid("ext"), name: c.str("name"), ...optional({ object: c.optStr("object") }) };
  },
  "extension.removed": (data) => ({ ext: new Check(data).uuid("ext") }),
  "extension.purged": (data) => ({ ext: new Check(data).uuid("ext") }),
  "contact.created": (data) => ({ cid: new Check(data).uuid("cid") }),
  "contact.petname": (data) => {
    const c = new Check(data);
    return { cid: c.uuid("cid"), name: c.str("name") };
  },
  "contact.flag": (data) => {
    const c = new Check(data);
    return { cid: c.uuid("cid"), ...c.flags() };
  },
  "contact.useKey": (data) => {
    const c = new Check(data);
    return { cid: c.uuid("cid"), key: c.key("key"), because: c.str("because") };
  },
  "contact.attached": (data) => {
    const c = new Check(data);
    return { ...c.channel(), cid: c.uuid("cid"), because: c.oneOf("because", ["invitation", "accepted", "manual"]), ...optional({ oobId: c.optStr("oobId") }) };
  },
  "contact.detached": (data) => {
    const c = new Check(data);
    return { ...c.channel(), cid: c.uuid("cid") };
  },
  "contact.merged": (data) => {
    const c = new Check(data);
    const cid = c.uuid("cid");
    const from = c.uuid("from");
    if (from === cid) {
      throw "from is the contact itself";
    }
    return { cid, from };
  },
  "contact.deleted": (data) => ({ cid: new Check(data).uuid("cid") }),
};

/** Every type this document names, in the order above. */
export const VAULT_TYPES = Object.keys(READERS) as VaultType[];

/**
 * The event as one of the vault's types, its `data` read; `null` for a
 * type this document does not name (an extension's, a later version's:
 * not this fold's to read). Throws `Malformed` on a type it names whose
 * `data` is not what the type says.
 */
export function readVaultEvent(event: Event): VaultEvent | null {
  if (!isVaultType(event.type)) {
    return null;
  }
  const read = READERS[event.type] as (data: JsonObject) => JsonObject;
  try {
    return { ...event, data: read(event.data) } as VaultEvent;
  } catch (err) {
    throw new Malformed(event, typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
  }
}
