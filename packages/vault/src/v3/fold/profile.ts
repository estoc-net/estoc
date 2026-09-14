/**
 * The profile facts of each relationship: the names the peer claimed,
 * lifted from inbound disclosures, and the disclosures of our own
 * profile the peer was sent. A lift names one exact source event; what
 * it means depends on that source's standing — an inbound source must
 * be a complete, scoped observation of a complete group in the same
 * relationship, an outbound source a submitted, verified member of it.
 * Lifts of one logical source are one: the observations of one wire
 * ID and intent in the relationship, whatever key each arrived at, or
 * the intent events of one message ID. Sources are ordered by their
 * earliest event, never by when they were lifted, so recovering an old
 * lift moves nothing; two names lifted from one source contradict, and
 * that source names nothing while every other still does.
 */

import { compareEvents } from "@estoc/event-store/v3";

import type { EventId, MessageId, RelationshipId } from "../types.js";
import type { VaultEvent } from "../schema.js";
import type { OutboundFold } from "./outbound.js";
import type { RelationshipFold } from "./relationships.js";
import { compareKeys, groupBy, keyOf, type SourceKey, type VaultEventSet } from "./set.js";

export interface NameClaim {
  /** the source's earliest event */
  readonly sourceKey: SourceKey;
  /** every observation of the logical source, in canonical order */
  readonly sourceEventIds: readonly EventId[];
  readonly liftEventIds: readonly EventId[];
  /** the names lifted, sorted; more than one is the source's conflict */
  readonly names: readonly string[];
  readonly conflict: boolean;
}

export interface Share {
  readonly messageId: MessageId;
  readonly sourceKey: SourceKey;
  readonly liftEventIds: readonly EventId[];
}

export interface Profile {
  readonly relationshipId: RelationshipId;
  /** the name of the latest source that names one, null while none does */
  readonly claimedName: string | null;
  /** some source has two names lifted from it */
  readonly nameConflict: boolean;
  /** the key of the latest disclosure of our profile the peer was sent, null while none */
  readonly shared: SourceKey | null;
  /** every logical inbound source with a lift, in source order */
  readonly claims: readonly NameClaim[];
  /** every submitted disclosure with a lift, in source order */
  readonly shares: readonly Share[];
  readonly deferred: readonly string[];
  readonly faults: readonly string[];
}

/** The profile of a relationship, empty when nothing was lifted for it. */
export function profileOf(profiles: ReadonlyMap<RelationshipId, Profile>, relationshipId: RelationshipId): Profile {
  return profiles.get(relationshipId) ?? { relationshipId, claimedName: null, nameConflict: false, shared: null, claims: [], shares: [], deferred: [], faults: [] };
}

type ClaimDraft = { sourceKey: SourceKey; sourceEventIds: EventId[]; liftEventIds: EventId[]; names: Set<string> };
type ShareDraft = { messageId: MessageId; sourceKey: SourceKey; liftEventIds: EventId[] };

export function foldProfiles(set: VaultEventSet, relationships: RelationshipFold, outbound: OutboundFold): ReadonlyMap<RelationshipId, Profile> {
  const receiptsByMessage = groupBy(set.of("message.in"), (event) => event.data.messageId);
  const logical = new Map<string, { sourceKey: SourceKey; events: VaultEvent<"message.in">[] }>();
  for (const [messageId, group] of relationships.groups) {
    if (group.status !== "complete") continue;
    const receipts = [...receiptsByMessage.get(messageId)!].sort(compareEvents);
    const key = JSON.stringify([group.relationshipId, receipts[0]!.data.wireMessageId, receipts[0]!.data.intentHash]);
    const known = logical.get(key);
    if (known === undefined) logical.set(key, { sourceKey: keyOf(receipts[0]!), events: receipts });
    else {
      if (compareKeys(keyOf(receipts[0]!), known.sourceKey) < 0) known.sourceKey = keyOf(receipts[0]!);
      known.events.push(...receipts);
    }
  }
  for (const source of logical.values()) source.events.sort(compareEvents);

  const claimed = groupBy(set.of("profile.nameClaimed"), (event) => event.data.relationshipId);
  const shared = groupBy(set.of("profile.shared"), (event) => event.data.relationshipId);
  const profiles = new Map<RelationshipId, Profile>();
  for (const relationshipId of [...new Set([...claimed.keys(), ...shared.keys()])].sort()) {
    const faults: string[] = [];
    const deferred: string[] = [];
    const claims = new Map<string, ClaimDraft>();
    for (const lift of claimed.get(relationshipId) ?? []) {
      const source = set.resolve(lift.data.sourceEventId, "message.in");
      if (source.status === "mismatched") {
        faults.push(`lift ${lift.eventId} names ${source.event.type} as its source`);
        continue;
      }
      if (source.status === "missing") {
        deferred.push(`lift ${lift.eventId} awaits its source ${lift.data.sourceEventId}`);
        continue;
      }
      const scope = relationships.observations.get(source.event.eventId)!;
      const group = relationships.groups.get(source.event.data.messageId)!;
      if (scope.status === "anonymous") faults.push(`lift ${lift.eventId} names an anonymous source`);
      else if (scope.status === "conflict") faults.push(`lift ${lift.eventId} names a source that contradicts: ${scope.because}`);
      else if (group.status === "conflict") faults.push(`lift ${lift.eventId} names a source whose group is in conflict: ${group.because}`);
      else if (scope.relationshipId !== null && scope.relationshipId !== relationshipId) faults.push(`lift ${lift.eventId} names a source scoped in ${scope.relationshipId}`);
      else if (scope.status === "deferred") deferred.push(`lift ${lift.eventId} awaits its source's scope: ${scope.because}`);
      else if (group.status !== "complete") deferred.push(`lift ${lift.eventId} awaits its source's group: ${group.status === "incomplete" ? group.because : "anonymous"}`);
      else {
        const key = JSON.stringify([relationshipId, source.event.data.wireMessageId, source.event.data.intentHash]);
        const logicalSource = logical.get(key)!;
        const draft = claims.get(key);
        if (draft === undefined) claims.set(key, { sourceKey: logicalSource.sourceKey, sourceEventIds: logicalSource.events.map((event) => event.eventId), liftEventIds: [lift.eventId], names: new Set([lift.data.name]) });
        else {
          draft.liftEventIds.push(lift.eventId);
          draft.names.add(lift.data.name);
        }
      }
    }
    const shares = new Map<MessageId, ShareDraft>();
    for (const lift of shared.get(relationshipId) ?? []) {
      const source = set.resolve(lift.data.sourceEventId, "message.out");
      if (source.status === "mismatched") {
        faults.push(`lift ${lift.eventId} names ${source.event.type} as its source`);
        continue;
      }
      if (source.status === "missing") {
        deferred.push(`lift ${lift.eventId} awaits its source ${lift.data.sourceEventId}`);
        continue;
      }
      const { messageId } = source.event.data;
      const message = outbound.outbounds.get(messageId)!;
      if (source.event.data.relationshipId !== relationshipId) faults.push(`lift ${lift.eventId} names a source of relationship ${source.event.data.relationshipId}`);
      else if (message.intent === null) faults.push(`lift ${lift.eventId} names a source whose intent events disagree`);
      else if (message.conflict) faults.push(`lift ${lift.eventId} names a source in conflict: ${message.faults.join("; ")}`);
      else if (message.membership.status === "deferred") deferred.push(`lift ${lift.eventId} awaits its source's membership: ${message.membership.because}`);
      else if (!message.submitted) deferred.push(`lift ${lift.eventId} awaits the submission of its source`);
      else {
        const draft = shares.get(messageId);
        if (draft !== undefined) draft.liftEventIds.push(lift.eventId);
        else {
          const sourceKey = message.intentEventIds
            .flatMap((eventId) => {
              const intent = set.resolve(eventId, "message.out");
              return intent.status === "present" ? [keyOf(intent.event)] : [];
            })
            .sort(compareKeys)[0]!;
          shares.set(messageId, { messageId, sourceKey, liftEventIds: [lift.eventId] });
        }
      }
    }
    const claimList: NameClaim[] = [...claims.values()].sort((a, b) => compareKeys(a.sourceKey, b.sourceKey)).map((draft) => ({ sourceKey: draft.sourceKey, sourceEventIds: draft.sourceEventIds, liftEventIds: draft.liftEventIds.sort(), names: [...draft.names].sort(), conflict: draft.names.size > 1 }));
    const shareList: Share[] = [...shares.values()].sort((a, b) => compareKeys(a.sourceKey, b.sourceKey)).map((draft) => ({ ...draft, liftEventIds: draft.liftEventIds.sort() }));
    const named = claimList.filter((claim) => !claim.conflict).at(-1);
    profiles.set(relationshipId, {
      relationshipId,
      claimedName: named?.names[0] ?? null,
      nameConflict: claimList.some((claim) => claim.conflict),
      shared: shareList.at(-1)?.sourceKey ?? null,
      claims: claimList,
      shares: shareList,
      deferred,
      faults,
    });
  }
  return profiles;
}
