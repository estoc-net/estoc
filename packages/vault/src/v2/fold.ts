/**
 * The folds (vault-events.md §7): attribution, contact state, my DIDs
 * and devices, invitations, deliveries, the keep-set (§8.3) and the
 * erased roots (§8.2), all from one event set with `self` as the one
 * parameter (§1 principle 3). Pure: the projection is a function of the
 * set, recomputed after any event is applied, so events arrive in any
 * order, one at a time (§7), and the result is the same.
 */

import type { Cid, Event, EventStore } from "@estoc/event-store";
import { compareEvents } from "@estoc/event-store";

import { peerKeyOf } from "./peer-key.js";
import { Components, EventSet, latest } from "./set.js";
import {
  CHANNEL_DECISIONS,
  OBSERVATIONS,
  VAULT_TYPES,
  channelId,
  isMediationKey,
  type AttachCause,
  type ChannelKey,
  type DeliveryOutcome,
  type EnvelopeKind,
  type Malformed,
  type MessageIn,
  type MessageOut,
  type PublishedAs,
  type Uses,
  type VaultEvent,
} from "./types.js";

// ---- projections -----------------------------------------------------------

/** Which contact a channel belongs to (§7.1). */
export type Attribution =
  | { kind: "none" }
  | { kind: "one"; cid: string }
  /** a multi-valued conflict: shown, resolved by `contact.merged` */
  | { kind: "several"; cids: string[] }
  /** every contact it is attached to is deleted (§9): hidden */
  | { kind: "deleted"; cids: string[] };

export interface Channel {
  pair: ChannelKey;
  /** the earliest `channel.firstSeen`, by any device */
  firstSeen: { at: string; by: string; kind: EnvelopeKind; peerPublicKey: string | null; firstDid: string | null } | null;
  /** every device with a `channel.firstSeen` on it */
  seenBy: string[];
  /** the latest `peer.resolved` on this pair, per DID */
  resolved: { did: string; keys: string[]; service: string | null; at: string }[];
  /** the DIDs joined to it in the identity graph (§7.1) */
  dids: string[];
  attribution: Attribution;
  /** the mids of the messages carrying it, in canonical order */
  messages: string[];
}

export type DeliveryStatus = "pending" | "failed" | "held" | "sent";

export interface Delivery {
  mid: string;
  /** `sent` is final; `held` is `self`'s own hold; `failed` means retry (§3.1) */
  status: DeliveryStatus;
  attempts: { attempt: number; outcome: DeliveryOutcome; error: string | null; at: string; by: string }[];
  heldBy: { dev: string; because: "user" | "imported"; at: string }[];
}

export interface Message {
  mid: string;
  direction: "in" | "out";
  pair: ChannelKey;
  eid: string;
  at: string;
  author: string;
  /**
   * Inbound: the DID the peer key wore at this message — the latest
   * `peer.resolved` on the pair before it in canonical order, else the
   * DID the key was first seen with, else null (anonymous). Outbound:
   * null; the addressee is in the plaintext.
   */
  sender: string | null;
  skeleton: MessageIn | MessageOut;
  /** the roots some `message.erased` for this mid dropped */
  erased: Cid[];
  /** outbound only */
  delivery: Delivery | null;
}

export interface ContactKey {
  key: string;
  /** from `did.minted`; null when this set has not seen it minted */
  did: string | null;
  routingDid: string | null;
  because: string;
  /** added by the fold: an invitation this contact took (§7.4) */
  implicit: boolean;
  since: string;
}

export interface TheirDid {
  did: string;
  /** the keys of the latest `peer.resolved` for it */
  keys: string[];
  service: string | null;
  rotatedTo: string[];
  /** a chain's end */
  current: boolean;
}

export interface Attached {
  pair: ChannelKey;
  because: AttachCause;
  /** the invitation it took, when `because` says so */
  oobId: string | null;
  at: string;
  by: string;
}

export interface Contact {
  /** the representative: the smallest live cid of the component (§6) */
  cid: string;
  /** every live member, `cid` among them */
  members: string[];
  /** members with a `contact.deleted`: contribute nothing (§7.2) */
  hidden: string[];
  createdAt: string | null;
  petname: string | null;
  flags: Record<string, boolean>;
  claimedName: string | null;
  /** the latest `profile.shared` across the attributed channels: when a profile of ours last went out to them */
  profileSharedAt: string | null;
  keys: ContactKey[];
  theirDids: TheirDid[];
  /** two or more is a multi-valued conflict, shown */
  currentDids: string[];
  addressedAs: string | null;
  /** the channels attributed to this contact alone */
  channels: ChannelKey[];
  /** every live `contact.attached` of its members, in canonical order: how each channel came to it */
  attached: Attached[];
  /** the unfrozen ones (§3.2) */
  writeTo: ChannelKey[];
  /** the default among `writeTo`; null: mint or rotate before sending */
  write: ChannelKey | null;
  /** every message across the attributed channels, in canonical order */
  thread: Message[];
}

export interface DeletedContact {
  cid: string;
  members: string[];
  /** the channels attributed to this contact alone, before it was deleted */
  channels: ChannelKey[];
  /** every `contact.useKey` (and implicit invitation key) of its members: what §9 step 3 retires */
  keys: ContactKey[];
}

export interface Published {
  as: PublishedAs;
  uses: Uses;
  oobId: string | null;
  goal: string | null;
  at: string;
  by: string;
}

export interface MyKey {
  key: string;
  minted: { did: string; routingDid: string | null; mediation: string | null; at: string; by: string } | null;
  /** the devices whose mediator accepted it */
  registered: string[];
  published: Published[];
  retired: { because: string; at: string; by: string } | null;
  /** contacts with a live `contact.useKey` on it */
  usedBy: string[];
  /** contacts with a live `contact.attached` on one of its channels */
  takenBy: string[];
}

export interface Mediation {
  id: string;
  mediatorDid: string;
  me: { key: string; did: string };
  createdAt: string;
  /** the device it binds */
  by: string;
  routingDid: string | null;
  retired: { because: string; at: string } | null;
  /** the device's latest `created` without a `retired` */
  current: boolean;
  /** the channels under its `me` key: the mediator's (§3) */
  channels: ChannelKey[];
}

export interface Device {
  dev: string;
  mintedAt: string | null;
  label: string | null;
  retired: { because: string; at: string; by: string } | null;
  mediation: Mediation | null;
  mediations: Mediation[];
}

export interface Extension {
  ext: string;
  name: string;
  object: string | null;
  installedAt: string;
  by: string;
  removed: boolean;
  purged: boolean;
}

export interface Invitation {
  key: string;
  did: string | null;
  oobId: string | null;
  goal: string | null;
  at: string;
  by: string;
  open: boolean;
  takenBy: string[];
}

interface Projection {
  channels: Map<string, Channel>;
  contacts: Map<string, Contact>;
  deleted: Map<string, DeletedContact>;
  /** every cid → its representative */
  memberOf: Map<string, string>;
  keys: Map<string, MyKey>;
  devices: Map<string, Device>;
  label: string | null;
  extensions: Map<string, Extension>;
  invitations: Invitation[];
  messages: Map<string, Message>;
  held: Set<Cid>;
}

// ---- the fold --------------------------------------------------------------

export class VaultFold {
  private readonly set = new EventSet();
  private cache: Projection | null = null;

  constructor(readonly self: string) {}

  /** Every event of `events`, folded; `self` is the store's unless given. */
  static async of(events: EventStore, self: string = events.self): Promise<VaultFold> {
    const fold = new VaultFold(self);
    for await (const event of events.scan()) {
      fold.apply(event);
    }
    return fold;
  }

  /** One more event, in any order; false if it was already here. */
  apply(event: Event): boolean {
    const added = this.set.add(event);
    if (added) {
      this.cache = null;
    }
    return added;
  }

  get size(): number {
    return this.set.size;
  }

  /** Lines of a vault type whose `data` is not what the type says (§1): held, not read. */
  get malformed(): readonly Malformed[] {
    return this.set.malformed;
  }

  private get p(): Projection {
    if (this.cache === null) {
      this.cache = project(this.set, this.self);
    }
    return this.cache;
  }

  channels(): Channel[] {
    return [...this.p.channels.values()];
  }

  channel(pair: ChannelKey): Channel | null {
    return this.p.channels.get(channelId(pair)) ?? null;
  }

  attribution(pair: ChannelKey): Attribution {
    return this.channel(pair)?.attribution ?? { kind: "none" };
  }

  /** Every live contact, by representative, in cid order. */
  contacts(): Contact[] {
    return [...this.p.contacts.values()];
  }

  /** The contact `cid` is a member of; null when deleted or unknown. */
  contact(cid: string): Contact | null {
    const rep = this.p.memberOf.get(cid);
    return rep === undefined ? null : (this.p.contacts.get(rep) ?? null);
  }

  deletedContacts(): DeletedContact[] {
    return [...this.p.deleted.values()];
  }

  myKeys(): MyKey[] {
    return [...this.p.keys.values()];
  }

  myKey(name: string): MyKey | null {
    return this.p.keys.get(name) ?? null;
  }

  devices(): Device[] {
    return [...this.p.devices.values()];
  }

  device(dev: string): Device | null {
    return this.p.devices.get(dev) ?? null;
  }

  /** What the identity calls itself (§5). */
  label(): string | null {
    return this.p.label;
  }

  extensions(): Extension[] {
    return [...this.p.extensions.values()];
  }

  invitations(): Invitation[] {
    return this.p.invitations;
  }

  message(mid: string): Message | null {
    return this.p.messages.get(mid) ?? null;
  }

  /** Every message, any channel, in canonical order. */
  messages(): Message[] {
    return [...this.p.messages.values()].sort(compareEvents);
  }

  delivery(mid: string): Delivery | null {
    return this.message(mid)?.delivery ?? null;
  }

  /** The roots the events hold (§8.3): the `keep` for `collect`, and what a merge copies (§10). */
  held(): Cid[] {
    return [...this.p.held].sort();
  }

  /** Whether some `message.erased` for `mid` names `root` (§8.2): asked before the blocks. */
  erased(mid: string, root: Cid): boolean {
    return this.message(mid)?.erased.includes(root) ?? false;
  }
}

// ---- the projection --------------------------------------------------------

const qualifies = (pair: ChannelKey): boolean => pair.peerKey !== null && !isMediationKey(pair.myKey);
const channelNode = (pair: ChannelKey): string => `c:${channelId(pair)}`;
const didNode = (did: string): string => `d:${did}`;

function project(set: EventSet, self: string): Projection {
  // ---- channels: every pair an observation or an attachment carries
  const channels = new Map<string, Channel>();
  const channel = (pair: ChannelKey): Channel => {
    const id = channelId(pair);
    let have = channels.get(id);
    if (have === undefined) {
      have = { pair: { myKey: pair.myKey, peerKey: pair.peerKey }, firstSeen: null, seenBy: [], resolved: [], dids: [], attribution: { kind: "none" }, messages: [] };
      channels.set(id, have);
    }
    return have;
  };
  for (const type of [...OBSERVATIONS, ...CHANNEL_DECISIONS, "contact.attached", "contact.detached"] as const) {
    for (const event of set.of(type)) {
      channel(event.data);
    }
  }
  for (const event of set.of("channel.firstSeen")) {
    const have = channel(event.data);
    if (have.firstSeen === null) {
      have.firstSeen = { at: event.at, by: event.author, kind: event.data.kind, peerPublicKey: event.data.peerPublicKey ?? null, firstDid: event.data.firstDid ?? null };
    }
    if (!have.seenBy.includes(event.author)) {
      have.seenBy.push(event.author);
    }
  }
  const resolutionsOf = new Map<string, VaultEvent<"peer.resolved">[]>();
  for (const event of set.of("peer.resolved")) {
    const have = channel(event.data);
    const entry = { did: event.data.did, keys: [...event.data.keys], service: event.data.service ?? null, at: event.at };
    const at = have.resolved.findIndex((r) => r.did === entry.did);
    if (at === -1) {
      have.resolved.push(entry);
    } else {
      have.resolved[at] = entry; // set.of is canonical order: the last one for a did is the latest
    }
    const id = channelId(event.data);
    resolutionsOf.set(id, [...(resolutionsOf.get(id) ?? []), event]); // every one, in canonical order: what a message's sender is read from
  }
  /** the DID the pair's peer key wore at an inbound message: the latest resolution before it, else the first-seen DID */
  const senderOf = (event: VaultEvent<"message.in">): string | null => {
    const before = (resolutionsOf.get(channelId(event.data)) ?? []).filter((resolution) => compareEvents(resolution, event) < 0).at(-1);
    return before?.data.did ?? channel(event.data).firstSeen?.firstDid ?? null;
  };

  // ---- the identity graph (§7.1)
  const graph = new Components();
  for (const have of channels.values()) {
    if (qualifies(have.pair)) {
      graph.add(channelNode(have.pair));
    }
  }
  for (const event of set.of("peer.resolved")) {
    if (qualifies(event.data)) {
      graph.union(channelNode(event.data), didNode(event.data.did));
    }
  }
  for (const event of set.of("peer.rotated")) {
    if (qualifies(event.data)) {
      graph.union(didNode(event.data.from), didNode(event.data.to));
    }
  }
  const didsOf = new Map<string, string[]>();
  for (const [root, nodes] of graph.groups()) {
    didsOf.set(
      root,
      nodes.filter((node) => node.startsWith("d:")).map((node) => node.slice(2))
    );
  }
  for (const have of channels.values()) {
    if (qualifies(have.pair)) {
      have.dids = didsOf.get(graph.find(channelNode(have.pair))) ?? [];
    }
  }

  // ---- contacts as components under contact.merged (§6)
  const contactGraph = new Components();
  const deletedCids = new Set<string>();
  for (const type of ["contact.created", "contact.petname", "contact.flag", "contact.useKey", "contact.attached", "contact.detached", "contact.merged", "contact.deleted"] as const) {
    for (const event of set.of(type)) {
      contactGraph.add(event.data.cid);
    }
  }
  for (const event of set.of("contact.merged")) {
    contactGraph.union(event.data.cid, event.data.from);
  }
  for (const event of set.of("contact.deleted")) {
    deletedCids.add(event.data.cid);
  }
  const memberOf = new Map<string, string>();
  const components: { rep: string; members: string[]; hidden: string[]; live: boolean; deadRep: string | null }[] = [];
  for (const members of contactGraph.groups().values()) {
    const live = members.filter((cid) => !deletedCids.has(cid));
    const hidden = members.filter((cid) => deletedCids.has(cid));
    const rep = (live[0] ?? members[0]) as string;
    for (const cid of members) {
      memberOf.set(cid, rep);
    }
    components.push({ rep, members: live, hidden, live: live.length > 0, deadRep: [...hidden].sort()[0] ?? null });
  }
  const byRep = new Map(components.map((component) => [component.rep, component]));

  // ---- live attachments: the latest of attached/detached per (cid, channel)
  interface Attach {
    cid: string;
    rep: string;
    /** its `cid` is tombstoned: contributes nothing to a live contact (§7.2) */
    dead: boolean;
    pair: ChannelKey;
    because: AttachCause;
    oobId: string | null;
    at: string;
    eid: string;
    author: string;
  }
  const attachEvents = new Map<string, VaultEvent<"contact.attached" | "contact.detached">>();
  for (const event of [...set.of("contact.attached"), ...set.of("contact.detached")]) {
    const key = `${event.data.cid}\n${channelId(event.data)}`;
    const have = attachEvents.get(key);
    if (have === undefined || compareEvents(have, event) < 0) {
      attachEvents.set(key, event);
    }
  }
  const attaches: Attach[] = [];
  for (const event of attachEvents.values()) {
    if (event.type === "contact.attached") {
      attaches.push({
        cid: event.data.cid,
        rep: memberOf.get(event.data.cid) as string,
        dead: deletedCids.has(event.data.cid),
        pair: { myKey: event.data.myKey, peerKey: event.data.peerKey },
        because: event.data.because,
        oobId: event.data.oobId ?? null,
        at: event.at,
        eid: event.eid,
        author: event.author,
      });
    }
  }

  // ---- attribution (§7.1)
  const attachesByComponent = new Map<string, Attach[]>();
  for (const attach of attaches) {
    if (!qualifies(attach.pair)) {
      continue;
    }
    const root = graph.find(channelNode(attach.pair));
    const list = attachesByComponent.get(root);
    if (list === undefined) {
      attachesByComponent.set(root, [attach]);
    } else {
      list.push(attach);
    }
  }
  for (const have of channels.values()) {
    if (!qualifies(have.pair)) {
      continue;
    }
    const here = attachesByComponent.get(graph.find(channelNode(have.pair))) ?? [];
    const live = [...new Set(here.filter((attach) => !attach.dead).map((attach) => attach.rep))].sort();
    const dead = [...new Set(here.filter((attach) => attach.dead).map((attach) => byRep.get(attach.rep)?.deadRep ?? attach.rep))].sort();
    if (live.length === 1) {
      have.attribution = { kind: "one", cid: live[0] as string };
    } else if (live.length > 1) {
      have.attribution = { kind: "several", cids: live };
    } else if (dead.length > 0) {
      have.attribution = { kind: "deleted", cids: dead };
    }
  }

  // ---- messages, erases, deliveries (§3.1, §8)
  const erasedOf = new Map<string, Set<Cid>>();
  for (const event of set.of("message.erased")) {
    let drops = erasedOf.get(event.data.mid);
    if (drops === undefined) {
      drops = new Set();
      erasedOf.set(event.data.mid, drops);
    }
    for (const root of event.data.drop) {
      drops.add(root);
    }
  }
  const attemptsOf = new Map<string, Delivery["attempts"]>();
  for (const event of set.of("delivery.attempted")) {
    const list = attemptsOf.get(event.data.mid) ?? [];
    list.push({ attempt: event.data.attempt, outcome: event.data.outcome, error: event.data.error ?? null, at: event.at, by: event.author });
    attemptsOf.set(event.data.mid, list);
  }
  const heldOf = new Map<string, Delivery["heldBy"]>();
  for (const event of set.of("delivery.held")) {
    const list = heldOf.get(event.data.mid) ?? [];
    list.push({ dev: event.author, because: event.data.because, at: event.at });
    heldOf.set(event.data.mid, list);
  }
  const messages = new Map<string, Message>();
  const messageEvents = [...set.of("message.in"), ...set.of("message.out")].sort(compareEvents);
  for (const event of messageEvents) {
    const mid = event.data.mid;
    if (messages.has(mid)) {
      continue; // one mid, two skeletons: the first by canonical order is the message
    }
    const direction = event.type === "message.in" ? "in" : "out";
    let delivery: Delivery | null = null;
    if (direction === "out") {
      const attempts = attemptsOf.get(mid) ?? [];
      const heldBy = heldOf.get(mid) ?? [];
      let status: DeliveryStatus = "pending";
      if (attempts.some((attempt) => attempt.outcome === "sent")) {
        status = "sent";
      } else if (heldBy.some((held) => held.dev === self)) {
        status = "held";
      } else if (attempts.length > 0) {
        status = "failed";
      }
      delivery = { mid, status, attempts, heldBy };
    }
    const message: Message = {
      mid,
      direction,
      pair: { myKey: event.data.myKey, peerKey: event.data.peerKey },
      eid: event.eid,
      at: event.at,
      author: event.author,
      sender: event.type === "message.in" ? senderOf(event) : null,
      skeleton: event.data,
      erased: [...(erasedOf.get(mid) ?? [])].sort(),
      delivery,
    };
    messages.set(mid, message);
    channel(message.pair).messages.push(mid);
  }

  // ---- the keep-set (§8.3)
  const held = new Set<Cid>(set.foreignRoots());
  for (const type of VAULT_TYPES) {
    for (const event of set.of(type)) {
      const drops = event.type === "message.in" || event.type === "message.out" ? erasedOf.get(event.data.mid) : undefined;
      for (const root of event.blobs) {
        if (drops === undefined || !drops.has(root)) {
          held.add(root);
        }
      }
    }
  }

  // ---- my keys (§7.3)
  const keys = new Map<string, MyKey>();
  const myKey = (name: string): MyKey => {
    let have = keys.get(name);
    if (have === undefined) {
      have = { key: name, minted: null, registered: [], published: [], retired: null, usedBy: [], takenBy: [] };
      keys.set(name, have);
    }
    return have;
  };
  for (const event of set.of("did.minted")) {
    const have = myKey(event.data.key);
    if (have.minted === null) {
      have.minted = { did: event.data.did, routingDid: event.data.routingDid, mediation: event.data.mediation, at: event.at, by: event.author };
    }
  }
  for (const event of set.of("did.registered")) {
    const have = myKey(event.data.key);
    if (!have.registered.includes(event.author)) {
      have.registered.push(event.author);
    }
  }
  for (const event of set.of("did.published")) {
    myKey(event.data.key).published.push({ as: event.data.as, uses: event.data.uses, oobId: event.data.oobId ?? null, goal: event.data.goal ?? null, at: event.at, by: event.author });
  }
  for (const event of set.of("did.retired")) {
    const have = myKey(event.data.key);
    if (have.retired === null) {
      have.retired = { because: event.data.because, at: event.at, by: event.author };
    }
  }
  for (const attach of attaches) {
    if (attach.pair.myKey !== null && !attach.dead) {
      const have = myKey(attach.pair.myKey);
      if (!have.takenBy.includes(attach.rep)) {
        have.takenBy.push(attach.rep);
      }
    }
  }
  const isCurrentKey = (name: string): boolean => {
    const have = keys.get(name);
    return have !== undefined && have.minted !== null && have.retired === null;
  };

  // ---- mediations and devices (§5, §7.3)
  const granted = new Map<string, VaultEvent<"mediation.granted">>();
  for (const event of set.of("mediation.granted")) {
    const have = granted.get(event.data.id);
    if (have === undefined || compareEvents(have, event) < 0) {
      granted.set(event.data.id, event);
    }
  }
  const retiredMediation = new Map<string, VaultEvent<"mediation.retired">>();
  for (const event of set.of("mediation.retired")) {
    if (!retiredMediation.has(event.data.id)) {
      retiredMediation.set(event.data.id, event);
    }
  }
  const mediations = new Map<string, Mediation>();
  const mediationsBy = new Map<string, Mediation[]>();
  for (const event of set.of("mediation.created")) {
    if (mediations.has(event.data.id)) {
      continue;
    }
    const retired = retiredMediation.get(event.data.id);
    const mediation: Mediation = {
      id: event.data.id,
      mediatorDid: event.data.mediatorDid,
      me: { ...event.data.me },
      createdAt: event.at,
      by: event.author,
      routingDid: granted.get(event.data.id)?.data.routingDid ?? null,
      retired: retired === undefined ? null : { because: retired.data.because, at: retired.at },
      current: false,
      channels: [...channels.values()].filter((have) => have.pair.myKey === event.data.me.key).map((have) => have.pair),
    };
    mediations.set(mediation.id, mediation);
    const list = mediationsBy.get(event.author) ?? [];
    list.push(mediation);
    mediationsBy.set(event.author, list);
  }
  const devices = new Map<string, Device>();
  const devIds = new Set<string>(set.authors());
  for (const type of ["device.label", "device.retired"] as const) {
    for (const event of set.of(type)) {
      devIds.add(event.data.dev);
    }
  }
  for (const dev of [...devIds].sort()) {
    const minted = set.of("device.minted").find((event) => event.author === dev);
    const label = latest(set.of("device.label").filter((event) => event.data.dev === dev));
    const retired = latest(set.of("device.retired").filter((event) => event.data.dev === dev));
    const own = mediationsBy.get(dev) ?? [];
    const current = retired === null ? (own.filter((m) => m.retired === null).at(-1) ?? null) : null; // a retired device has no live address (§10)
    if (current !== null) {
      current.current = true;
    }
    devices.set(dev, {
      dev,
      mintedAt: minted?.at ?? null,
      label: label?.data.name ?? null,
      retired: retired === null ? null : { because: retired.data.because, at: retired.at, by: retired.author },
      mediation: current,
      mediations: own,
    });
  }

  // ---- the identity (§7.3)
  const label = latest(set.of("identity.label"))?.data.name ?? null;
  const extensions = new Map<string, Extension>();
  for (const event of set.of("extension.installed")) {
    if (!extensions.has(event.data.ext)) {
      extensions.set(event.data.ext, { ext: event.data.ext, name: event.data.name, object: event.data.object ?? null, installedAt: event.at, by: event.author, removed: false, purged: false });
    }
  }
  for (const event of set.of("extension.removed")) {
    const have = extensions.get(event.data.ext);
    if (have !== undefined) {
      have.removed = true;
    }
  }
  for (const event of set.of("extension.purged")) {
    const have = extensions.get(event.data.ext);
    if (have !== undefined) {
      have.removed = true;
      have.purged = true;
    }
  }

  // ---- invitations (§7.4)
  const invitations: Invitation[] = [];
  for (const event of set.of("did.published")) {
    if (event.data.as !== "oob" || event.data.uses !== "one") {
      continue;
    }
    const have = myKey(event.data.key);
    const takers = attaches.filter((attach) => attach.pair.myKey === event.data.key);
    invitations.push({
      key: event.data.key,
      did: have.minted?.did ?? null,
      oobId: event.data.oobId ?? null,
      goal: event.data.goal ?? null,
      at: event.at,
      by: event.author,
      open: have.retired === null && takers.length === 0,
      takenBy: [...new Set(takers.filter((attach) => !attach.dead).map((attach) => attach.rep))].sort(),
    });
  }
  const oneUse = new Set(invitations.map((invitation) => invitation.key));

  // ---- contact state (§7.2)
  const resolvedByDid = new Map<string, VaultEvent<"peer.resolved">>();
  for (const event of set.of("peer.resolved")) {
    const have = resolvedByDid.get(event.data.did);
    if (have === undefined || compareEvents(have, event) < 0) {
      resolvedByDid.set(event.data.did, event);
    }
  }
  const rotatedFrom = new Map<string, Set<string>>();
  const firstMention = new Map<string, string>();
  const mention = (did: string, at: string): void => {
    const have = firstMention.get(did);
    if (have === undefined || at < have) {
      firstMention.set(did, at);
    }
  };
  for (const event of set.of("peer.resolved")) {
    mention(event.data.did, event.at);
  }
  for (const event of set.of("peer.rotated")) {
    mention(event.data.from, event.at);
    mention(event.data.to, event.at);
    const tos = rotatedFrom.get(event.data.from) ?? new Set();
    tos.add(event.data.to);
    rotatedFrom.set(event.data.from, tos);
  }
  const contacts = new Map<string, Contact>();
  const deleted = new Map<string, DeletedContact>();
  const attributedTo = (rep: string, kind: "one" | "deleted"): Channel[] =>
    [...channels.values()].filter((have) => (kind === "one" ? have.attribution.kind === "one" && have.attribution.cid === rep : have.attribution.kind === "deleted" && have.attribution.cids.includes(rep)));
  const keyOrder = (a: ContactKey, b: ContactKey): number => (a.since !== b.since ? (a.since < b.since ? -1 : 1) : a.key < b.key ? -1 : 1);
  /** Every `contact.useKey` of `cids` plus the implicit key of each invitation `mine` took (§7.4); `lastUse` is filled with each key's latest use. */
  const contactKeysOf = (cids: Set<string>, mine: (attach: Attach) => boolean, lastUse: Map<string, Pick<Event, "at" | "eid" | "author">>): ContactKey[] => {
    const contactKeys = new Map<string, ContactKey>();
    for (const event of set.of("contact.useKey")) {
      if (!cids.has(event.data.cid)) {
        continue;
      }
      lastUse.set(event.data.key, event); // canonical order: the last write is the latest use
      const have = contactKeys.get(event.data.key);
      if (have === undefined) {
        const minted = keys.get(event.data.key)?.minted ?? null;
        contactKeys.set(event.data.key, { key: event.data.key, did: minted?.did ?? null, routingDid: minted?.routingDid ?? null, because: event.data.because, implicit: false, since: event.at });
      } else {
        have.because = event.data.because; // events come in canonical order: the latest says why
        if (event.at < have.since) {
          have.since = event.at;
        }
      }
    }
    for (const attach of attaches) {
      if (mine(attach) && attach.pair.myKey !== null && oneUse.has(attach.pair.myKey) && !contactKeys.has(attach.pair.myKey)) {
        const minted = keys.get(attach.pair.myKey)?.minted ?? null;
        contactKeys.set(attach.pair.myKey, { key: attach.pair.myKey, did: minted?.did ?? null, routingDid: minted?.routingDid ?? null, because: "invitation", implicit: true, since: attach.at });
        lastUse.set(attach.pair.myKey, attach);
      }
    }
    return [...contactKeys.values()];
  };
  for (const component of components) {
    if (component.deadRep !== null) {
      const gone = contactKeysOf(new Set(component.hidden), (attach) => attach.dead && attach.rep === component.rep, new Map()).sort(keyOrder);
      deleted.set(component.deadRep, { cid: component.deadRep, members: component.hidden, channels: attributedTo(component.deadRep, "deleted").map((have) => have.pair), keys: gone });
    }
    if (!component.live) {
      continue;
    }
    const members = new Set(component.members);
    const own = <T extends "contact.created" | "contact.petname" | "contact.flag" | "contact.useKey">(type: T): VaultEvent<T>[] => set.of(type).filter((event) => members.has(event.data.cid));
    const attributed = attributedTo(component.rep, "one");
    const attributedIds = new Set(attributed.map((have) => channelId(have.pair)));
    const onAttributed = <T extends "message.in" | "profile.nameClaimed" | "profile.shared">(type: T): VaultEvent<T>[] => set.of(type).filter((event) => attributedIds.has(channelId(event.data)));

    const flags: Record<string, boolean> = {};
    const flagAt = new Map<string, VaultEvent<"contact.flag">>();
    for (const event of own("contact.flag")) {
      for (const [flag, value] of Object.entries(event.data)) {
        if (flag === "cid" || typeof value !== "boolean") {
          continue;
        }
        const have = flagAt.get(flag);
        if (have === undefined || compareEvents(have, event) < 0) {
          flagAt.set(flag, event);
          flags[flag] = value;
        }
      }
    }

    const lastUse = new Map<string, Pick<Event, "at" | "eid" | "author">>();
    const liveKeys = contactKeysOf(members, (attach) => !attach.dead && attach.rep === component.rep, lastUse)
      .filter((entry) => (keys.get(entry.key)?.retired ?? null) === null)
      .sort(keyOrder);
    for (const entry of liveKeys) {
      const have = myKey(entry.key);
      if (!have.usedBy.includes(component.rep)) {
        have.usedBy.push(component.rep);
      }
    }

    const didSet = new Set<string>();
    for (const have of attributed) {
      for (const did of have.dids) {
        didSet.add(did);
      }
    }
    const theirDids = orderByRotation(didSet, rotatedFrom, firstMention).map((did): TheirDid => {
      const resolved = resolvedByDid.get(did);
      const rotatedTo = [...(rotatedFrom.get(did) ?? [])].filter((to) => didSet.has(to)).sort();
      return { did, keys: resolved?.data.keys ?? [], service: resolved?.data.service ?? null, rotatedTo, current: rotatedTo.length === 0 };
    });
    const currentDids = theirDids.filter((entry) => entry.current).map((entry) => entry.did);
    const currentPeerKeys = new Set<string>();
    for (const entry of theirDids) {
      if (!entry.current) {
        continue;
      }
      for (const key of entry.keys) {
        try {
          currentPeerKeys.add(peerKeyOf(key));
        } catch {
          // a key the document lists in a form this fold cannot fingerprint: not one of theirs, as far as it can tell
        }
      }
    }

    const inbound = onAttributed("message.in");
    const latestIn = latest(inbound);
    const writeTo = attributed.filter((have) => have.pair.myKey !== null && isCurrentKey(have.pair.myKey) && have.pair.peerKey !== null && currentPeerKeys.has(have.pair.peerKey)).map((have) => have.pair);
    let write: ChannelKey | null = null;
    const latestWritable = latest(inbound.filter((event) => writeTo.some((pair) => pair.myKey === event.data.myKey && pair.peerKey === event.data.peerKey)));
    if (latestWritable !== null) {
      write = { myKey: latestWritable.data.myKey, peerKey: latestWritable.data.peerKey };
    } else {
      const lastUsed = (entry: ContactKey): Pick<Event, "at" | "eid" | "author"> => lastUse.get(entry.key) as Pick<Event, "at" | "eid" | "author">;
      const latestUse = [...liveKeys].sort((a, b) => compareEvents(lastUsed(a), lastUsed(b))).at(-1); // the latest `contact.useKey` (§7.2), by canonical order
      write = latestUse === undefined ? null : (writeTo.find((pair) => pair.myKey === latestUse.key) ?? null);
    }

    const thread = attributed
      .flatMap((have) => have.messages)
      .map((mid) => messages.get(mid) as Message)
      .sort(compareEvents);
    const attachedHere = attaches
      .filter((attach) => !attach.dead && attach.rep === component.rep)
      .sort(compareEvents)
      .map((attach): Attached => ({ pair: attach.pair, because: attach.because, oobId: attach.oobId, at: attach.at, by: attach.author }));

    contacts.set(component.rep, {
      cid: component.rep,
      members: component.members,
      hidden: component.hidden,
      createdAt: own("contact.created")[0]?.at ?? null,
      petname: latest(own("contact.petname"))?.data.name ?? null,
      flags,
      claimedName: latest(onAttributed("profile.nameClaimed"))?.data.name ?? null,
      profileSharedAt: latest(onAttributed("profile.shared"))?.at ?? null,
      keys: liveKeys,
      theirDids,
      currentDids,
      addressedAs: latestIn?.data.myKey ?? null,
      channels: attributed.map((have) => have.pair),
      attached: attachedHere,
      writeTo,
      write,
      thread,
    });
  }
  for (const have of keys.values()) {
    have.usedBy.sort();
    have.takenBy.sort();
  }

  return {
    channels,
    contacts: new Map([...contacts].sort(([a], [b]) => (a < b ? -1 : 1))),
    deleted: new Map([...deleted].sort(([a], [b]) => (a < b ? -1 : 1))),
    memberOf,
    keys: new Map([...keys].sort(([a], [b]) => (a < b ? -1 : 1))),
    devices,
    label,
    extensions: new Map([...extensions].sort(([a], [b]) => (a < b ? -1 : 1))),
    invitations,
    messages,
    held,
  };
}

/**
 * DIDs in rotation order (§7.2): a `from` before every `to` it rotated
 * to, ties and cycles by first mention then name — a total order that is
 * a function of the set.
 */
function orderByRotation(dids: Set<string>, rotatedFrom: Map<string, Set<string>>, firstMention: Map<string, string>): string[] {
  const byMention = (a: string, b: string): number => {
    const ma = firstMention.get(a) ?? "";
    const mb = firstMention.get(b) ?? "";
    return ma !== mb ? (ma < mb ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
  };
  const remaining = new Set(dids);
  const incoming = new Map<string, number>();
  for (const did of dids) {
    incoming.set(did, 0);
  }
  for (const did of dids) {
    for (const to of rotatedFrom.get(did) ?? []) {
      if (dids.has(to)) {
        incoming.set(to, (incoming.get(to) as number) + 1);
      }
    }
  }
  const out: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((did) => incoming.get(did) === 0).sort(byMention);
    const next = ready[0] ?? [...remaining].sort(byMention)[0]; // a cycle: break it at the earliest mention
    const did = next as string;
    out.push(did);
    remaining.delete(did);
    for (const to of rotatedFrom.get(did) ?? []) {
      if (remaining.has(to)) {
        incoming.set(to, (incoming.get(to) as number) - 1);
      }
    }
  }
  return out;
}
