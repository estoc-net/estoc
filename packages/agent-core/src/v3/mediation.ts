/**
 * Mediation as the vault records it and the mediator confirms it. An
 * arrangement is created in the vault before the mediator is asked,
 * so a network failure leaves a retryable intent and never a half
 * identity; the grant is recorded when it comes; the desired recipient
 * set — every live DID bound to a mediated route of the arrangement —
 * is reconciled with what the mediator holds on every connection,
 * since registration is runtime state and not the vault's; and the
 * selection for new routes is the vault's to record. Every step reads
 * the fold and is safe to repeat: what the events already say is not
 * asked for again.
 */

import { v7 as uuidv7 } from "uuid";

import type { VaultRuntime } from "@estoc/event-store/v3";
import { mediationKeyName, mintMediationDid, scanVault, vaultDraft, type Did, type Keys, type Mediation, type MediationId, type VaultEvent, type VaultFold } from "@estoc/vault/v3";

import type { IMessage } from "../protocol/didcomm.js";
import { MEDIATE_GRANT, MEDIATE_REQUEST, RECIPIENT, RECIPIENT_QUERY, RECIPIENT_UPDATE, RECIPIENT_UPDATE_RESPONSE } from "../protocol/mediation.js";
import { EntityConflict, MediatorRefused, UnknownEntity, Unusable, WrongAccount, WrongMediator } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { decide, serially } from "./procedure.js";
import { sameDid } from "./same-did.js";

/** The arrangement as the fold has it; `UnknownEntity` when it has none. */
export function mediationOf(fold: VaultFold, mediationId: MediationId): Mediation {
  const mediation = fold.mediations.mediations.get(mediationId);
  if (mediation === undefined) throw new UnknownEntity("mediation", mediationId);
  return mediation;
}

/**
 * The link must be the arrangement's own: to its mediator, speaking as
 * its identity. Two arrangements with one mediator are two accounts
 * there, and a ritual run as one and recorded against the other would
 * grant, register and disclose under the wrong one.
 */
function toward(link: MediatorLink, mediation: Mediation): void {
  if (mediation.mediatorDid !== null && !sameDid(mediation.mediatorDid, link.mediatorDid)) throw new WrongMediator(mediation.mediatorDid, link.mediatorDid);
  if (mediation.me !== null && !sameDid(mediation.me.did, link.me)) throw new WrongAccount(mediation.me.did, link.me);
}

/**
 * `mediation.created` for a new arrangement with `mediatorDid`: the
 * vault-controlled identity toward the mediator, minted from the
 * arrangement's own key name. Committed before any network request.
 * The same ID again returns the creation already recorded when it
 * says the same, and refuses one that says otherwise.
 */
export async function createMediation(runtime: VaultRuntime, keys: Keys, mediatorDid: Did, mediationId = uuidv7() as MediationId): Promise<VaultEvent<"mediation.created">> {
  const me = await mintMediationDid(keys, mediationId);
  const data = { mediationId, mediatorDid, me: { keyName: mediationKeyName(mediationId), did: me.longFormDid } };
  const { fold, events } = await decide(runtime, keys, (fold) => {
    const existing = fold.mediations.mediations.get(mediationId);
    if (existing === undefined) return [vaultDraft("mediation.created", data)];
    if (existing.mediatorDid !== data.mediatorDid || existing.me?.did !== data.me.did) throw new EntityConflict("mediation", mediationId, existing.faults.join("; ") || "another mediator or identity");
    return [];
  });
  return (events[0] as VaultEvent<"mediation.created"> | undefined) ?? (fold.set.of("mediation.created").find((event) => event.data.mediationId === mediationId) as VaultEvent<"mediation.created">);
}

export type EstablishStep = "granted" | "reconciled";

export interface Established {
  mediation: Mediation;
  /** what this run had to do, in order */
  steps: EstablishStep[];
  reconciled: Reconciled;
}

/**
 * mediate-request → `mediation.granted` → recipients reconciled, each
 * only when the fold lacks it: a grant recorded is not asked for
 * again. Needs the arrangement created toward the link's mediator and
 * neither retired nor in conflict. Selecting it for new routes is a
 * separate step, `selectMediation`, since it is policy's.
 */
export async function establish(link: MediatorLink, runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<Established> {
  let fold = await scanVault(runtime.vault, keys);
  let mediation = mediationOf(fold, mediationId);
  toward(link, mediation);
  if (mediation.status === "conflict" || mediation.status === "retired" || mediation.me === null) {
    throw new Unusable("mediation", mediationId, [...mediation.faults, ...(mediation.retired === null ? [] : [`retired: ${mediation.retired}`]), ...(mediation.me === null ? ["no creation"] : [])]);
  }
  const steps: EstablishStep[] = [];
  if (mediation.routingDid === null) {
    const grant = await link.roundTrip(MEDIATE_REQUEST, {});
    if (grant.type !== MEDIATE_GRANT) throw new MediatorRefused(`expected mediate-grant, got ${grant.type}`);
    const routing = grant.body["routing_did"];
    const routingDid = Array.isArray(routing) ? routing[0] : undefined;
    if (typeof routingDid !== "string") throw new MediatorRefused("mediate-grant carries no routing_did");
    const decided = await decide(runtime, keys, (fold) => {
      const current = mediationOf(fold, mediationId);
      return current.routingDid === null && current.status === "pending" ? [vaultDraft("mediation.granted", { mediationId, routingDid: routingDid as Did })] : [];
    });
    if (decided.events.length > 0) steps.push("granted");
    fold = await scanVault(runtime.vault, keys);
    mediation = mediationOf(fold, mediationId);
  }
  const reconciled = await reconcile(link, runtime, keys, mediationId);
  steps.push("reconciled");
  return { mediation, steps, reconciled };
}

export interface Reconciled {
  mediationId: MediationId;
  /** the live DIDs on the arrangement's mediated routes, by short form: what the mediator is to hold */
  desired: Did[];
  /** what the mediator held before this run */
  held: Did[];
  added: Did[];
  removed: Did[];
  /** what the mediator would not add or remove; a desired DID among them is not registered */
  refused: Did[];
}

/** Is `did` registered with the mediator as of this reconciliation? */
export function registered(reconciled: Reconciled, did: Did): boolean {
  return reconciled.desired.includes(did) && !reconciled.refused.includes(did);
}

/**
 * recipient-query, then one recipient-update for the difference between
 * what the mediator holds and the desired set: every live DID bound to
 * a mediated route of this arrangement, by its short form, and nothing
 * else. Needs a usable arrangement; the diff goes to the `diag` trace.
 * Runs as the account's one procedure at a time, over the fold as it
 * stands on entry: a desired set read earlier could be missing a DID
 * disclosed since, and would have it removed.
 */
export function reconcile(link: MediatorLink, runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<Reconciled> {
  return serially(runtime, mediationId, async () => reconcileNow(link, await scanVault(runtime.vault, keys), mediationId));
}

/** `reconcile` for a caller that already holds the account's turn and a fold read under it. */
export async function reconcileNow(link: MediatorLink, fold: VaultFold, mediationId: MediationId): Promise<Reconciled> {
  const mediation = mediationOf(fold, mediationId);
  toward(link, mediation);
  if (mediation.status !== "usable") throw new Unusable("mediation", mediationId, mediation.faults.length > 0 ? mediation.faults : [mediation.status]);
  const desired = fold.routes.desiredRecipients.filter((recipient) => recipient.mediationId === mediationId).map((recipient) => recipient.did);
  const held = await queryRecipients(link);
  const added = desired.filter((did) => !held.includes(did));
  const removed = held.filter((did) => !desired.includes(did));
  const refused: Did[] = [];
  if (added.length > 0 || removed.length > 0) {
    const updates = [...added.map((did) => ({ recipient_did: did, action: "add" })), ...removed.map((did) => ({ recipient_did: did, action: "remove" }))];
    const answer = await link.roundTrip(RECIPIENT_UPDATE, { updates });
    if (answer.type !== RECIPIENT_UPDATE_RESPONSE) throw new MediatorRefused(`expected recipient-update-response, got ${answer.type}`);
    const results = resultsOf(answer);
    const done = (did: Did, action: string): boolean => {
      const result = results.get(updateKey(did, action));
      return result === "success" || result === "no_change";
    };
    for (const did of added) if (!done(did, "add")) refused.push(did);
    for (const did of removed) if (!done(did, "remove")) refused.push(did);
  }
  const reconciled: Reconciled = { mediationId, desired, held, added: added.filter((did) => !refused.includes(did)), removed: removed.filter((did) => !refused.includes(did)), refused };
  await link.observe("diag", "reconcile", { ...reconciled });
  return reconciled;
}

/** Every recipient DID the mediator holds for this account, page by page. */
async function queryRecipients(link: MediatorLink): Promise<Did[]> {
  const dids: Did[] = [];
  for (let offset = 0; ; ) {
    const answer = await link.roundTrip(RECIPIENT_QUERY, { paginate: { limit: 100, offset } });
    if (answer.type !== RECIPIENT) throw new MediatorRefused(`expected recipient, got ${answer.type}`);
    const page = answer.body["dids"];
    const entries = Array.isArray(page) ? page : [];
    for (const entry of entries) {
      const did = (entry as { recipient_did?: unknown })?.recipient_did;
      if (typeof did === "string") dids.push(did as Did);
    }
    const pagination = answer.body["pagination"] as { remaining?: unknown } | undefined;
    const remaining = typeof pagination?.remaining === "number" ? pagination.remaining : 0;
    if (entries.length === 0 || remaining <= 0) return dids;
    offset += entries.length;
  }
}

function updateKey(did: string, action: string): string {
  return `${action} ${did}`;
}

/**
 * recipient-update-response: the result of each update, by the DID and
 * the action together, since a success at removing is no success at
 * adding. An entry missing its action or its DID says nothing; two
 * entries for one update that disagree say nothing either.
 */
function resultsOf(answer: IMessage): Map<string, string | undefined> {
  const results = new Map<string, string | undefined>();
  const updated = answer.body["updated"];
  for (const entry of Array.isArray(updated) ? updated : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const { recipient_did, action, result } = entry as { recipient_did?: unknown; action?: unknown; result?: unknown };
    if (typeof recipient_did !== "string" || typeof action !== "string") continue;
    const key = updateKey(recipient_did, action);
    const value = typeof result === "string" ? result : undefined;
    results.set(key, results.has(key) && results.get(key) !== value ? undefined : value);
  }
  return results;
}

/** `mediation.selected`: the arrangement policy prefers for new mediated routes. Needs a usable one; already the latest selection, nothing is written. */
export async function selectMediation(runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<VaultEvent<"mediation.selected"> | null> {
  const { events } = await decide(runtime, keys, (fold) => {
    const mediation = mediationOf(fold, mediationId);
    if (mediation.status !== "usable") throw new Unusable("mediation", mediationId, mediation.faults.length > 0 ? mediation.faults : [mediation.status]);
    return fold.mediations.selected === mediationId ? [] : [vaultDraft("mediation.selected", { mediationId })];
  });
  return (events[0] as VaultEvent<"mediation.selected"> | undefined) ?? null;
}
