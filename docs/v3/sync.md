# sync/1.0 — the vault among siblings — provisional

Status: **draft**, 2026-09-02, *provisional throughout*; not
implemented. A DIDComm protocol, `https://estoc.dev/sync/1.0`, spoken
only between devices of one identity — the siblings of `devices.md`,
over the channels of the self contact (`devices.md` §6). Goes with
version 3 of the vault: what it carries is the interchange format of
`event-store.md` §10.1, and every rule about what may be written is
that document's. Design history:
`research/notes/2026-09-02-per-device-seed-and-agent-split.md` §9.

## 1. What siblings exchange

What siblings exchange is the vault: events, and the blocks those
events hold. The folder is the interchange format (`event-store.md`
§10.1) and a sync is "ingest what the other holds that I lack"
(`vault-folder.md` §10). Two things do it, and only the second is
relied on. A **push** carries what a device has just appended to
every live sibling, at once, for latency; it promises nothing. A
**reconciliation** compares the two sets and fills whichever side is
short, on open and on a timer, for convergence: it remembers nothing
between rounds, so nothing a device forgets, drops, or fails to write
is skipped for good — it is a difference the next round shows again.
`ingest` is idempotent (`event-store.md` §4.2), so sending what the
other already holds costs a message and nothing else, and the protocol
errs that way throughout.

## 2. Push

After every `append`, the device sends the events it appended to each
live sibling, with those of their blocks that fit:

```json
{
  "type": "https://estoc.dev/sync/1.0/events",
  "id": "<uuid>",
  "body": { "store": null, "events": [ { "eid": "…", "at": "…", "author": "…", "type": "…", "blobs": [], "data": {} } ] },
  "attachments": [
    { "id": "bafkrei…", "media_type": "application/vnd.ipld.raw", "byte_count": 100, "data": { "base64": "…" } }
  ]
}
```

- `body.store` — `null` for the vault's own set, an `ext` for an
  extension store's (`event-store.md` §8); each store is synced as the
  set it is. A store the fold over this device's vault set says is
  purged (`vault-events.md` §7.3) is neither pushed nor reconciled;
  one this device does not yet hold comes into being with the first
  write, as on import (`event-store.md` §10.3).
- `body.events` — envelopes as `event-store.md` §2 defines them, in no
  promised order, as many as fit under the mediator's envelope limit
  with their blocks; the rest in another message; a message may carry
  blocks and no events, as an answer to a `want` does (§3). The
  receiver `ingest`s (`event-store.md` §4.2): duplicates skipped,
  conflicts reported, and an event of `self` it never wrote is a
  forked self and stops the ingest — a sibling that sends us our own
  events back is fine, one that sends us events of ours we do not
  have is the fault that check exists for. Every event carries its
  author's signature (`event-store.md` §2.5) and `ingest` checks it,
  so a sibling can relay any device's events and forge none: what a
  message says C wrote is what C wrote, or is rejected. Sync rests on
  this — without it a compromised sibling could write in a live
  device's name and leave words behind that its own retirement would
  not make suspect.
- `attachments` — blocks, by CID as `object-share.md` §2 carries them:
  those the message's events hold (`vault-events.md` §8.3) that fit
  inline; ones that do not travel by package (`object-share.md` §8) or
  are left out — a block a line names and the store lacks is
  *missing*, `vault-events.md` §8.2 says what that reads as, and the
  receiver's next `want` asks for it. A receiver writes the blocks a
  message carries before it ingests its lines (`event-store.md` §5.2);
  the gap this leaves for blocks left out is the one that rule allows.
  Blocks come in by collectability, as a merge's do (`vault-events.md`
  §10): an erased blob is never sent.
- Files (`state/` and the unknown paths, `vault-folder.md` §6) are not
  in the first version's sync; a backup carries them.

A push that is lost, or reaches a device that crashes before it wrote,
or is stopped by a forked self, is gone: no token, no receipt and no
retry stand behind it, because none is needed. The reconciliation is
what converges, and a device keeps no record of what it pushed to
whom — such a record would be the per-device high-water mark
`event-store.md` §4.2 says not to keep, and its being wrong would be a
silent divergence, which is the one failure a sync must not have.

## 3. Reconciliation

An `eid` is a UUIDv7, so a store's events sorted by `eid` are in mint
order, and a **range** `[from, to)` of that order is a slice of the
set that both sides can compute over. The order is the `eid`'s, not
`at`'s, and each side computes over the events it holds, so an author
that mints `eid`s out of time makes ranges lopsided and never makes
equal sets compare unequal. A device opens a round with `have`: its
set as ranges, each a fingerprint or, when small enough, the `eid`s
themselves; and `want`, the blocks it lacks:

```json
{
  "type": "https://estoc.dev/sync/1.0/have",
  "id": "<uuid>",
  "body": {
    "store": null,
    "ranges": [
      { "from": null,     "to": "0198a…", "count": 4812, "hash": "b0Wm…" },
      { "from": "0198a…", "to": "0198f…", "count": 37,   "hash": "k7q3…" },
      { "from": "0198f…", "to": null,     "eids": [ "0198f…", "0198f…" ] }
    ],
    "want": [ "bafkrei…" ]
  }
}
```

- `ranges` — in the `have` that opens a round, cover the whole order
  in order, `from: null` the beginning and `to: null` the end, so that
  the message states the sender's whole set; in a reply, only the
  ranges still in question. A range is a **fingerprint** — `count`,
  and `hash`, the sha-256 of the sender's `eid`s in it, sorted and
  concatenated, base64url — or a **list**, `eids`, the `eid`s
  themselves. How a sender cuts ranges is its own: it lists a range it
  can list under the envelope limit and fingerprints the rest, and on
  a later turn splits a fingerprint that came back unequal; the other
  side computes over the bounds it is given, whatever they are. A
  device may remember when it was last level with a sibling and
  fingerprint everything before that as one range — a cache, lost
  harmlessly.
- `want` — the CIDs of blocks the sender lacks that a root it holds
  (`vault-events.md` §8.3) reaches: the frontier at which its walk
  stops. Answered with the blocks a root the *answerer* holds reaches,
  and no others — an erase on the answering side wins, as always —
  inline or by package; what is still missing is the next `want`'s.

The receiver of a `have` computes, for each range, its own fingerprint
or list over the same bounds and compares. An equal range is done. A
listed range says exactly which `eid`s each side lacks: the receiver
pushes what the list lacks, by `sync/1.0/events` with blocks as a push
carries them, and returns the range, listed, only if the list holds
what it lacks — so that the other side pushes in turn. A fingerprint
that differs says only that the range differs: the receiver returns
it, split or listed, so that the next turn narrows it. Its reply is a
`have` of the ranges it returns and its own `want`; a `have` that
returns no range ends the round, and whether the last push landed is
the next round's question, not this one's. Two rounds open at once,
one from each side, are two rounds: nothing in a `have` refers to an
earlier message.

After a round in which no message was lost, two live siblings hold the
same events, and the same blocks for every root both hold, less what
would not go under the limit and package; after a round in which
something was lost, the next round shows the difference again. What
each side states is what it holds, never what it sent or was sent,
which is what makes a round repeatable and the loss of any local
state a slower first turn and nothing else. A forked self stops an
`ingest` and is reported, and reconciliation does not paper over it:
the range stays unequal round after round until the person acts
(`event-store.md` §4.2) — the alarm, not a fault of the sync. A
retired device is sent nothing, no round is opened toward it, and a
`have` from it is not answered; what it pushes is ingested and folds
as its events do — suspect (`vault-events.md` §5).

A device new to the identity starts, in this version, from a snapshot
(`devices.md` §5). A round from an empty set is the whole vault and
would converge — every range unequal, every event pushed — but through
the mediator's envelopes, which is what the zip spares; a first sync
that replaces the zip is open (§4). The cost is the mediator's: a
`have` is one hash per range, a round localises a difference to the
ranges that hold it, a level pair exchanges a few hundred bytes and a
device back after a week exchanges the week. A round takes the turns
its ranges need, and each turn waits for the other device to be
online.

## 4. Versioning, open

- **Version.** `sync/1.0` is a DIDComm protocol and versions as such;
  what it carries is the vault's interchange format, so a change of
  vault version is a change of what a message may carry, and the
  vault's version check (`vault-folder.md` §10) applies to a message's
  events as it does to a folder.
- **Provisional throughout**: a push of each append and a
  reconciliation by `eid` ranges, blocks by `want`, files not carried,
  zip to bootstrap. The bounds — how a sender cuts ranges, the timer,
  how much a `want` asks at once — are a client's and are unstated; a
  first sync that replaces the zip is the likely change. None of it
  touches an event type.
- **Files** (`vault-folder.md` §6) travel only by backup for now; a
  sync that carries `state/` and the unknown paths, each by its own
  policy, is a later version.
- **The self contact's channels** carry sync and nothing else; whether
  a person's note to themself across devices is a message in it, or
  an event of its own, is `devices.md` §8's question.
