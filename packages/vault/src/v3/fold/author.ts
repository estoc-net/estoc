/**
 * The vault-level scalars: which authors wrote and when, and the
 * identity's display name. An author is provenance, never ownership of
 * any communication state; the fold reports each one's span so a
 * runtime can see a second writer where phase 1 expects one.
 */

import type { AuthorId } from "@estoc/event-store/v3";

import { latest, type VaultEventSet } from "./set.js";

export type AuthorActivity = { author: AuthorId; firstEventAt: string; lastEventAt: string; events: number };

/** Every author seen on any event, by author ID, with the span of its wall-clock stamps. */
export function foldAuthors(set: VaultEventSet): AuthorActivity[] {
  const spans = new Map<AuthorId, AuthorActivity>();
  for (const event of set.all()) {
    const span = spans.get(event.author);
    if (span === undefined) {
      spans.set(event.author, { author: event.author, firstEventAt: event.at, lastEventAt: event.at, events: 1 });
      continue;
    }
    if (event.at < span.firstEventAt) span.firstEventAt = event.at;
    if (event.at > span.lastEventAt) span.lastEventAt = event.at;
    span.events += 1;
  }
  return [...spans.values()].sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : 0));
}

/** The user-visible identity name: the latest `identity.label`, or null before any. */
export function foldLabel(set: VaultEventSet): string | null {
  return latest(set.of("identity.label"))?.data.name ?? null;
}
