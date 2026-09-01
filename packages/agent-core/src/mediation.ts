/**
 * The mediation rituals (vault-events.md §5): what this device settles
 * with its mediator over the link, and what it records of it — a grant
 * as `mediation.granted`, a DID the mediator accepted as
 * `did.registered`, a leaving as `did.retired` and `mediation.retired`.
 * Every step is decided over the fold and safe to repeat: a crash
 * between any two is healed by running the ritual again, which skips
 * what the log already says. The rituals decide nothing about contacts
 * or mail; they keep one invariant — every DID of ours that is an
 * address rides the current routing DID, and the mediator has been told
 * of it — and report what they did. "Ours" here is this device's: the
 * keys it minted (`did.minted` by `self`). Another device's keys are
 * seen in the fold and left alone (§5, §7.3: seen, not adopted) — not
 * registered under this device's `me`, which would take the mediator's
 * mapping from it, and not retired for riding a route that is not
 * ours. Moved from the v1 agent (`establishMediation`,
 * `registerRecipients`, `registerPending`, `leaveMediator`,
 * `rotateStale`), the records now events.
 */

import { drafts, record, type Mediation, type MyKey, type VaultFold } from "@estoc/vault/v2";

import type { IMessage } from "./protocol/didcomm.js";
import { MEDIATE_GRANT, MEDIATE_REQUEST, RECIPIENT_UPDATE, RECIPIENT_UPDATE_RESPONSE } from "./protocol/mediation.js";
import type { PeerVault } from "./identity.js";
import type { Keyring, MyIdentity, Routed } from "./keyring.js";
import type { MediatorLink } from "./link.js";

/** Why these rituals retire a key: its route is not the mediation's any more. */
const MEDIATION_CHANGED = "mediation-changed";
/** Why `leave` retires a mediation: the device moves to another. */
const CHANGED = "changed";

// ---- what the fold says -----------------------------------------------------

/** This device's current mediation (§5): the last `mediation.created` without a `mediation.retired`, plus its grant if any. */
export function current(fold: VaultFold, self: string): Mediation | null {
  return fold.device(self)?.mediation ?? null;
}

/** A mediation as a mint takes it (`Routed`): null while it has no routing DID. */
export function routedOf(mediation: Mediation | null): Routed | null {
  return mediation === null || mediation.routingDid === null ? null : { id: mediation.id, routingDid: mediation.routingDid };
}

/**
 * The keys this device minted on the current routing DID that its
 * mediator has not been told of (§7.3: `registered` without this
 * device) — the public DID, every live key toward a contact, every open
 * invitation — a mint that happened while the mediator could not be
 * told, or was told and the answer never recorded. Another device's
 * keys on the same route are its own to register. What `register`
 * takes; empty without a granted mediation.
 */
export function registerPending(fold: VaultFold, self: string): string[] {
  const mediation = current(fold, self);
  if (mediation === null || mediation.routingDid === null) {
    return [];
  }
  const routingDid = mediation.routingDid;
  const pending = new Set<string>();
  const consider = (key: MyKey | null): void => {
    if (key !== null && live(key) && ownedBy(key, self) && key.minted.routingDid === routingDid && !registeredBy(key, self)) {
      pending.add(key.key);
    }
  };
  for (const key of fold.myKeys()) {
    if (isProfile(key)) {
      consider(key);
    }
  }
  for (const contact of fold.contacts()) {
    for (const use of contact.keys) {
      consider(fold.myKey(use.key));
    }
  }
  for (const invitation of fold.invitations()) {
    if (invitation.open) {
      consider(fold.myKey(invitation.key));
    }
  }
  return [...pending];
}

// ---- establishing -------------------------------------------------------------

export type EstablishStep = "granted" | "published" | "registered";

export interface Established {
  mediation: Routed;
  /** the public DID under it, registered */
  pub: MyIdentity;
  /** what this run had to do, in order; empty when the log already said it all */
  steps: EstablishStep[];
}

/**
 * mediate-request → `mediation.granted` → the public DID minted and
 * `did.published` → recipient-update → `did.registered`, each only when
 * the fold lacks it: a grant recorded is not asked for again, a mint
 * that stopped before its publish is picked up (`Keyring.mintPublic`),
 * a publish before its register is registered now. Needs a current
 * mediation (`Keyring.createMediation`) toward the link's mediator.
 */
export async function establish(link: MediatorLink, keyring: Keyring, opened: PeerVault): Promise<Established> {
  const mediation = keyring.current();
  if (mediation === null) {
    throw new Error("no mediation to establish: create one first");
  }
  toward(link, mediation);
  const steps: EstablishStep[] = [];
  let routed = routedOf(mediation);
  if (routed === null) {
    const grant = await link.roundTrip(MEDIATE_REQUEST, {});
    if (grant.type !== MEDIATE_GRANT) {
      throw new Error(`expected mediate-grant, got ${grant.type}`);
    }
    const routing = grant.body["routing_did"];
    const routingDid = Array.isArray(routing) ? routing[0] : undefined;
    if (typeof routingDid !== "string") {
      throw new Error("mediate-grant carries no routing_did");
    }
    await record(opened.vault.events, opened.fold, drafts.mediationGranted({ id: mediation.id, routingDid }));
    routed = { id: mediation.id, routingDid };
    steps.push("granted");
  }
  let pub = keyring.pub();
  if (pub === null) {
    pub = await keyring.mintPublic(routed);
    steps.push("published");
  }
  if (!registeredBy(opened.fold.myKey(pub.key), opened.vault.self)) {
    await register(link, opened, [pub.key]);
    steps.push("registered");
  }
  return { mediation: routed, pub, steps };
}

/**
 * recipient-update `add` for `keys` in one breath, then `did.registered`
 * for each the mediator accepted (`success` or `no_change`). Keys the
 * fold already shows registered by this device are not asked about
 * again; none left, no round trip. One refused fails the call — after
 * the accepted are recorded, so the next run asks about the refused
 * alone. A key another device minted is refused here, before anything
 * is asked: registering it would take its mail. Returns the keys
 * recorded this time.
 */
export async function register(link: MediatorLink, opened: PeerVault, keys: readonly string[]): Promise<string[]> {
  const { fold, vault } = opened;
  toward(link, current(fold, vault.self));
  const pending: { key: string; did: string }[] = [];
  for (const key of new Set(keys)) {
    const have = fold.myKey(key);
    if (have === null || !minted(have)) {
      throw new Error(`${key} was never minted`);
    }
    if (!ownedBy(have, vault.self)) {
      throw new Error(`${key} was minted by another device: its to register`);
    }
    if (!registeredBy(have, vault.self)) {
      pending.push({ key, did: have.minted.did });
    }
  }
  if (pending.length === 0) {
    return [];
  }
  const answer = await link.roundTrip(RECIPIENT_UPDATE, { updates: pending.map(({ did }) => ({ recipient_did: did, action: "add" })) });
  if (answer.type !== RECIPIENT_UPDATE_RESPONSE) {
    throw new Error(`expected recipient-update-response, got ${answer.type}`);
  }
  const results = resultsOf(answer);
  const recorded: string[] = [];
  let refused = 0;
  for (const { key, did } of pending) {
    const result = results.get(did);
    if (result === "success" || result === "no_change") {
      await record(vault.events, fold, drafts.didRegistered({ key }));
      recorded.push(key);
    } else {
      refused += 1;
    }
  }
  if (refused > 0) {
    throw new Error(`the mediator did not accept ${refused} of ${pending.length} DID(s) of ours`);
  }
  return recorded;
}

// ---- leaving and moving -------------------------------------------------------

export interface Left {
  id: string;
  /** the keys retired: the public DID and every open invitation minted under the mediation */
  retired: string[];
  /** the DIDs the mediator was asked to drop: every key it may have been told of */
  dropped: string[];
  /** why it could not be asked, when it could not; the leaving stands */
  failed: string | null;
}

/**
 * Leaving the current mediation: `did.retired { because:
 * "mediation-changed" }` for the public DID and every open invitation
 * minted under it (their routes lead to a mediator that is no longer
 * ours), the mediator asked — best effort, in one breath — to drop
 * every DID it may have been told of: every one this device minted
 * under the arrangement, `did.registered` or not — that record lands
 * only when an add's answer comes back, and an add whose answer was
 * lost was applied all the same; removing what it never knew is a
 * no_change — so mail to a stale DID fails at the sender
 * rather than queueing where nobody looks, then `mediation.retired {
 * because: "changed" }`. Keys toward contacts stay: `rotateStale`
 * replaces them once the next mediation is granted. Null when there is
 * nothing to leave. The socket is the caller's to close.
 */
export async function leave(link: MediatorLink, opened: PeerVault): Promise<Left | null> {
  const { fold, vault } = opened;
  const mediation = current(fold, vault.self);
  if (mediation === null) {
    return null;
  }
  toward(link, mediation);
  const retired: string[] = [];
  const open = openInvitations(fold);
  for (const key of fold.myKeys()) {
    if (live(key) && key.minted.mediation === mediation.id && (isProfile(key) || open.has(key.key))) {
      await record(vault.events, fold, drafts.didRetired({ key: key.key, because: MEDIATION_CHANGED }));
      retired.push(key.key);
    }
  }
  const dropped = fold
    .myKeys()
    .filter((key): key is Minted => minted(key) && ownedBy(key, vault.self) && key.minted.mediation === mediation.id)
    .map((key) => key.minted.did);
  let failed: string | null = null;
  if (dropped.length > 0) {
    try {
      await link.roundTrip(RECIPIENT_UPDATE, { updates: dropped.map((did) => ({ recipient_did: did, action: "remove" })) });
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
  }
  await record(vault.events, fold, drafts.mediationRetired({ id: mediation.id, because: CHANGED }));
  return { id: mediation.id, retired, dropped, failed };
}

export interface Rotated {
  /** the contacts given a fresh key */
  moved: string[];
  /** the keys retired: toward those contacts, and the public DID and open invitations of the mediation itself when its route moved */
  retired: string[];
}

/**
 * The invariant a mediator change (or a grant that moved the route)
 * leaves to the next start: every live key this device minted toward a
 * contact rides the current routing DID. For a contact with one that
 * does not — the mediator was changed, whether or not this process saw
 * it — a fresh key is minted toward it (`Keyring.mintToward`) unless
 * one of ours on the route is there already (a run that stopped before
 * retiring), then every stale one is `did.retired { because:
 * "mediation-changed" }`; the contact learns by `from_prior` on what
 * goes out next. Another device's keys toward the contact ride its
 * route and are neither counted nor retired. The mediation's own public
 * DID and open invitations on an old route are retired the same way;
 * `establish` mints the next public DID. Nothing without a granted
 * mediation.
 */
export async function rotateStale(opened: PeerVault, keyring: Keyring): Promise<Rotated> {
  const { fold, vault } = opened;
  const mediation = keyring.current();
  const routed = routedOf(mediation);
  const done: Rotated = { moved: [], retired: [] };
  if (mediation === null || routed === null) {
    return done;
  }
  const ours = (key: MyKey | null): key is Minted => key !== null && live(key) && ownedBy(key, vault.self);
  const onRoute = (key: MyKey | null): boolean => ours(key) && key.minted.routingDid === routed.routingDid;
  const stale = (key: MyKey | null): key is Minted => ours(key) && key.minted.routingDid !== routed.routingDid;
  const retire = async (key: string): Promise<void> => {
    await record(vault.events, fold, drafts.didRetired({ key, because: MEDIATION_CHANGED }));
    done.retired.push(key);
  };
  for (const contact of fold.contacts()) {
    const keys = contact.keys.map((use) => fold.myKey(use.key));
    const old = keys.filter(stale);
    if (old.length === 0) {
      continue;
    }
    if (!keys.some(onRoute)) {
      await keyring.mintToward(contact.cid, routed);
    }
    for (const key of old) {
      await retire(key.key);
    }
    done.moved.push(contact.cid);
  }
  const open = openInvitations(fold);
  for (const key of fold.myKeys()) {
    if (stale(key) && key.minted.mediation === mediation.id && (isProfile(key) || open.has(key.key))) {
      await retire(key.key);
    }
  }
  return done;
}

// ---- inside -------------------------------------------------------------------

type Minted = MyKey & { minted: NonNullable<MyKey["minted"]> };

function minted(key: MyKey): key is Minted {
  return key.minted !== null;
}

/** Minted and not retired: a key that is still an address. */
function live(key: MyKey): key is Minted {
  return minted(key) && key.retired === null;
}

function isProfile(key: MyKey): boolean {
  return key.published.some((entry) => entry.as === "profile");
}

function registeredBy(key: MyKey | null, self: string): boolean {
  return key !== null && key.registered.includes(self);
}

/** Minted by this device: the one whose mediator it is registered with, and whose route it rides. */
function ownedBy(key: Minted, self: string): boolean {
  return key.minted.by === self;
}

function openInvitations(fold: VaultFold): Set<string> {
  return new Set(fold.invitations().filter((invitation) => invitation.open).map((invitation) => invitation.key));
}

/** The link must be to the mediation's mediator: a ritual recorded against another would be a lie in the log. */
function toward(link: MediatorLink, mediation: Mediation | null): void {
  if (mediation !== null && mediation.mediatorDid !== link.mediatorDid) {
    throw new Error("the link is to another mediator than the current mediation's");
  }
}

/** recipient-update-response: `updated[].recipient_did` → `result`. */
function resultsOf(answer: IMessage): Map<string, string | undefined> {
  const results = new Map<string, string | undefined>();
  const updated = answer.body["updated"];
  for (const entry of Array.isArray(updated) ? updated : []) {
    if (typeof entry === "object" && entry !== null) {
      const { recipient_did, result } = entry as { recipient_did?: unknown; result?: unknown };
      if (typeof recipient_did === "string") {
        results.set(recipient_did, typeof result === "string" ? result : undefined);
      }
    }
  }
  return results;
}
