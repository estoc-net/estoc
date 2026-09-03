# devices/1.0 — a contact with several devices — draft

Status: **draft**, 2026-09-02; not implemented. A DIDComm protocol,
`https://estoc.dev/devices/1.0`. Nothing in it depends on the vault:
it is what one party has to do to hold a counterpart that writes from
several devices, and what that counterpart's devices say to it. How an
Estoc device records what it hears is `vault-events.md` (§3.1, §6,
§7.2); which of its devices an Estoc identity introduces and drops,
and how the introducing is done, is `devices.md`; what its devices
exchange among themselves is `sync.md`. Design history:
`research/notes/2026-09-02-per-device-seed-and-agent-split.md` §5–§9.

**The model, in one paragraph.** A contact never sees an identity; it
sees **ends** — the current DIDs of the keys that write to it — and
each end is one device of the counterpart, because every key is one
device's. An identity adds a device by having a device the contact
already knows **vouch** for the new one's key; it drops a device by
having any other device **revoke** its keys, naming the moment they
stopped being the identity's, which the contact answers with a
**challenge** to the revoked end; anything the contact then hears
from a revoked end, the challenge's answer included, is a **conflict**
its person rules on, and nothing else is — and while it stands,
the end that revoked it is **disputed** and written to no more than
the end it revoked. A sender writes once and seals to every live end.
The identity's anchor takes no part: no key of it seals a message
here, and a contact is never asked to resolve one.

## 1. Principles

1. **An end is a device.** What a contact holds of a counterpart is a
   set of keys, each minted by one of the counterpart's devices, each
   wearing a DID; the DIDs a key wore in succession — `from_prior`
   rotations — are a **chain**, and the chain's latest DID is its
   **end**. A contact with three ends of a counterpart has three of
   its devices. Nothing tells a contact *which* device — no device id
   crosses the wire, ever, so that two contacts cannot compare notes
   and find they are talking to one identity.
2. **Adding is vouching; removing is revoking; both are said by a key
   the contact already trusts.** A vouch is a fact about the moment it
   was made, and stands for as long as that moment was its maker's
   own: a revoke names the chains it kills and the moment, `since`,
   from which their word was no longer the identity's, and a vouch
   the contact saw after that moment counts for nothing. A revoke
   kills the chains it names, and only those; what it undoes is what
   the named chains added, never what they killed.
3. **A revoked end has no second chance under that name.** Nothing
   heard from a revoked chain after its revoke is acted on; every word
   from it is shown as a conflict; a device that comes back comes back
   with a new key, vouched afresh. Revocation is therefore sticky by
   construction and needs no ordering between vouch and revoke:
   whichever arrives first, the chain is dead.
4. **The contact's person is the arbiter, locally.** A conflict — a
   revoked end that speaks, two ends revoking each other — is a
   projection and is resolved by a decision in the contact's own
   record, never reported back. A revoked end that speaks contradicts
   the end that revoked it, and the contact does not pick a side:
   neither is written to until the person rules. Timeouts are for
   showing, not for deciding: an end that answers late is a conflict,
   not a corpse.
5. **Send once, seal to every end.** Fan-out is the sender's, at the
   envelope; there is one message, with one id, and a copy per end
   (§8). Mediators do not know and need not.

## 2. Words

- **chain** — the DIDs one key of a counterpart's wore in succession,
  joined by `from_prior` rotations. Every DID is in exactly one chain.
  A DID rotated from twice gives the chain two **heads**, a fork:
  both stay in the chain, and it is shown (§7).
- **end** — a chain's latest DID, where a message to that device goes;
  of a fork's heads, the one the contact saw last.
- **conflict / dead / disputed / orphaned / live** — a chain's state,
  read off its record in the contact's fold (§7), the first that
  holds. Conflict: dead, and it spoke since; shown until ruled. Dead:
  revoked, or ruled so; nothing goes to it but a challenge. Disputed:
  it revoked an end that then spoke; nothing goes to it until the
  person rules (§6). Orphaned: every vouch that brought it in was
  withdrawn (§4); nothing goes to it, its words are shown, and a
  fresh vouch brings it back. Live: written to, its words acted on.
- **death** — a chain's time dead, from the counted revoke or the
  `dead` verdict that began it to the verdict that ends it. A
  challenge, a word from the dead end and the dispute it raises
  belong to a death, not to the chain: a chain ruled live and revoked
  again dies again, and is asked again (§7).
- **counted** — a vouch or revoke that arrived from a live chain, and
  so took effect (§7). One from a chain in any other state is a word
  from that chain and counts for nothing. A counted vouch is
  **withdrawn** when a later revoke says its maker was already gone
  when it was made (§4).

## 3. Vouch

A device the contact knows introduces a sibling's key:

```json
{
  "type": "https://estoc.dev/devices/1.0/vouch",
  "id": "<uuid>",
  "body": { "did": "did:peer:4…" }
}
```

- `body.did` — a DID of the sender's identity the contact may not
  know: the DID of a key another of its devices minted toward this
  contact. One DID per message.
- Sealed authcrypt from the vouching device's key toward the contact,
  like every message; the envelope is the proof that a key the contact
  trusts said it, and no signature inside is required. The message is
  fanned out to every live end of the contact (§8).

The contact records what the envelope proved: an edge from the DID the
sealing key wore (`by`) to `body.did` (`for`), and the message it came
in. Its effect is §7's: a chain that later opens under a key of `for`'s
document is the same counterpart from the moment the contact resolves
it — or before any such channel exists, since the contact may now
write to `for` (§8) and resolve it before sending.

Which devices vouch, and when, is the identity's own affair
(`devices.md` §5.1); what the contact has to allow for is that every
device of the counterpart may vouch for the same key, so that the
introduction does not wait on the one device that happens to be
offline, and that a key vouched for by several is not orphaned (§4)
when one of them is lost and its last vouches withdrawn. Two vouches
for one key are two counted edges and harmless. A key minted toward
the contact that it has no channel under and no vouch for yet is a
stranger's until the vouch lands; the fold unions, so the order in
which the new device's first message and the vouch arrive does not
matter beyond what the application shows meanwhile.

## 4. Revoke

A device that its identity has dropped is revoked toward every contact
by a message from every device that can reach them:

```json
{
  "type": "https://estoc.dev/devices/1.0/revoke",
  "id": "<uuid>",
  "body": {
    "dids": ["did:peer:4…B1", "did:peer:4…B2"],
    "since": "2026-09-01T18:40:00Z"
  }
}
```

- `body.dids` — every DID the dropped device's keys wore that this
  contact may know. Naming any DID of a chain kills the whole chain
  (§7); the sender names all it knows so that the contact need not
  have seen the same ones. Never a device id.
- `body.since` — optional; the moment, on the sender's wall clock,
  from which the named chains' word was no longer the identity's:
  when the device was lost, and at the latest the last time a sibling
  heard from it (`devices.md` §5.2). Absent, it is the moment the
  contact folds the revoke — a device leaving names its own chains
  and says nothing more.
- Sealed from the revoking device's key toward the contact; fanned out
  to every live end of the contact (§8). A device may name its own
  DIDs: that is a device leaving, and needs no challenge.

The contact records the edge — the DID the sealing key wore, the DIDs
named, `since`, the message — and the effect is §7's: the named
chains are dead, from the moment the observation is folded, and a
**challenge** (§5) is owed to each; and every counted vouch by a named
chain that the contact observed after `since` — by its own clock, in
its own record — is **withdrawn**. The chain it was for loses that
voucher, and a chain left with no counted voucher, that the person
did not accept and did not rule live, is **orphaned**: nothing goes
to it, its words are shown and not acted on, its own vouches are
withdrawn in turn, and a fresh counted vouch brings it back. A
revoke by a named chain is not withdrawn: what killed stays killed,
and the person rules on what it killed if they mean to (§6). A
`since` later than the contact's observation of the revoke is that
observation's moment. One earlier than a vouch the named chains made
withdraws it, honest or not, and a sibling's own vouch replaces the
honest one (`devices.md` §5.1): earlier is the safe error. A DID
named that is in another counterpart's chains is ignored — recorded,
shown, without effect: a revoke reaches only the identity it came
from. One the contact does not know is held as named-dead: it is a
name the revoker says was its own identity's, and a chain a vouch or
an accept later brings in under it is dead on arrival (§7).

Every device of the counterpart sends its own revoke, so the contact
is told even if the device that made the decision never comes back
online, and a contact with a channel to only one of the counterpart's
devices is told by that one. Two revokes naming one chain are one
death, and each withdraws by its own `since`: the earlier reaches
further, and nothing the later one left is put back. Two copies of
one revoke are one revoke, folded once (§7).

## 5. Challenge and response

A contact that has folded a counted revoke asks the revoked end whether
it is still there:

```json
{
  "type": "https://estoc.dev/devices/1.0/challenge",
  "id": "<uuid>",
  "body": { "by": "did:peer:4…A" }
}
```

- Sent to the revoked chain's end, sealed from a key of the contact's
  that the end's key has a channel with (or a fresh pair, resolved
  before sending). It is the one message a dead end is sent.
- `body.by` — the DID whose revoke this is, so that an honest device
  that answers knows which of its siblings retired it, and its person
  can tell whether that sibling is still theirs.
- Not sent when the revoke named the revoker's own chain (a device
  leaving), nor for a chain the person ruled dead (§6): there is
  nothing to ask. Nor to an orphaned chain (§4): nothing was said of
  it, only of the end that introduced it.

```json
{
  "type": "https://estoc.dev/devices/1.0/response",
  "id": "<uuid>",
  "thid": "<the challenge's id>",
  "body": {}
}
```

A device answers every challenge it can open, automatically, whenever
it is unlocked — one that its own identity has dropped included
(`devices.md` §5.3 says why), and one that is wiped or locked cannot.
The answer carries nothing: the envelope is the whole claim, "the key
you were told is dead just sealed this". On the contact's side it is
an inbound message on a dead chain and needs no type of its own in the
fold: it is a word from a dead end (§6), the chain is in conflict,
and the end that revoked it is disputed.

**Who challenges.** At least one device of the contact's sends a
challenge for every death by a counted revoke that did not name the
revoker's own chain — one per death, so a chain ruled live and
revoked again is asked again (§7); which of several does is the
contact's own arrangement, and two sending two, apart, get two
answers, each a word from the dead end, and there is one `spoke` to
set (§7, §8).

**Timeout.** How long the application shows "checking" before it
shows "gone" is the application's; nothing in the fold changes when it
expires. The chain was dead from the revoke; an answer that comes a
month later is a conflict all the same, which is why a device that is
closed, locked, or offline while the challenge waits loses nothing:
whenever it wakes it answers, and whenever it answers the conflict is
shown.

## 6. A word from a dead end, the dispute, and the verdict

Every observation on a channel whose chain is dead — a message, a
vouch, a revoke, a rotation, a response — is recorded as it is (an
observation is never refused a home) and does four things and
nothing else: it puts the chain in **conflict**; it is shown, marked;
it is not acted on — no handler runs on it, no reply is sent, no vouch
or revoke it carries takes effect, and a rotation it carries moves
the chain's end and nothing more, the new name as dead as the old
(§7); and it puts every end whose counted revoke killed the chain in
**dispute**. A disputed end is written to no more than a dead one,
its decisions are not counted, and its words are shown, marked, and
not acted on: the contact holds two ends that each say the other is
not the counterpart's, and it does not choose. Between a
revoke and the first word from the end it named there is no dispute:
a device that is lost, wiped or locked says nothing, and the end that
revoked it stays live and alone — the common case, and silent. A
chain the person ruled dead has no revoker to dispute; its words are
conflicts and nothing more. A copy of a word the chain said while it
was live, delivered again after its death, is no word from a dead
end: it was folded once, then (§7).

A word from a dead end is what the contact heard after it folded the
revoke, in its own order, not what the end said after it: a message
the end sent while it was still its identity's, delayed on the way,
arrives as one. The fold does not tell the two apart, and must not:
`created_time` is the sender's claim, and a rule that spared a word
older than `since` is beaten by a thief that sets `since` late. The
application shows them apart: a response whose `thid` is a challenge
of this death could only have been made after the challenge, and is
proof the key lived after its revoke (`answered`, §7); any other word
may be late traffic, and is shown with the moment its sender claims
for it, against `since`.

What the person then does is a decision, the **verdict**, on one
chain, named by any DID in it: `live` or `dead`.

- `live` — the person has satisfied themself, off the wire, that this
  is their contact's device: the chain is live again, written to, its
  words acted on from here on. It says nothing about the end that
  revoked it, which stays disputed until ruled in turn: if the old
  phone is honest the one that revoked it usually is not
  (`devices.md` §8), but a phone that was found is a phone whose
  siblings were honest too, so nothing is inferred and the person
  rules on both.
- `dead` — the person has decided it is gone: no challenge is sent,
  a later revoke naming it adds nothing, its words are conflicts, and
  every end that was disputed for revoking it is disputed no longer —
  its word was upheld — and is live again unless another chain it
  revoked still stands in conflict, or the rest of its record says
  otherwise (§7). A revoke need not have come first; a person told
  by their contact over the phone that a device is lost may rule it
  so before the counterpart's other devices have said anything.
- A verdict is one more event in the contact's own order: a later
  counted revoke kills a chain ruled live — a death of its own, with
  a challenge of its own — a later word from a chain ruled dead is a
  conflict again, and a `live` verdict for a chain that a sibling
  later re-vouches changes nothing it did not already say. A copy of
  the revoke the verdict answered, delivered again or seen late by
  another of the contact's devices, is not a later revoke (§7).
  A verdict on an orphaned chain is the same ruling: `live` makes it
  the counterpart's on the person's word, `dead` makes it dead. A
  verdict on a disputed chain ends its dispute either way.
- Never sent. The other side is told nothing; what it did with its
  devices is its own business, and what the contact believes is the
  contact's.

An **incident** is what the person is asked about: a chain in
conflict together with every end its death put in dispute, and every
chain those ends revoked, joined until nothing more joins. The fold
reports them (§7) so that the application asks once — "this
contact's devices disagree about which of them is theirs; ask them" —
and the answers are verdicts, one per chain: the fold has no ruling
on an incident, only on chains. The thief's case takes one: the end
the thief holds answered its challenge, the person rules it `dead`,
and the end that revoked it is live again.

An Estoc device records it as `contact.verdict` (`vault-events.md`
§6).

## 7. The contact's fold

The contact holds, per counterpart, a set of chains. Walk what it
observed of the counterpart in its own order, keeping per chain the
record below — its DIDs and `heads`, `accepted`, `vouchedBy`,
`revokedBy`, `ruled`, `disputedBy`, `challenged`, `spoke`,
`answered`, `words` — and a set of **named-dead** DIDs. The record is
the truth and the rules edit only it; a chain's **state** is read off
the record, the first that holds:
**conflict** if `spoke`; **dead** if `revokedBy` is not empty or
`ruled` is `dead`; **disputed** if `disputedBy` is not empty;
**orphaned** if it was not accepted, `vouchedBy` is empty and `ruled`
is not `live`; else **live**.

**One message, once.** A vouch, a revoke, a rotation, a response, a
message is identified by the counterpart, the chain it came from and
its `id` (§8). The first copy in the contact's order is the
observation; every later copy of the same identity with the same
plaintext is recorded as a copy of it and applies nothing, whatever
has happened since — a verdict is not undone by a copy of the revoke
it ruled on, and a mediator that delivers an envelope twice delivers
nothing. A later copy whose plaintext differs is not a copy: it is
folded as a message of its own, and the reused id is shown.

1. **A chain appears** when the person accepts a channel under one of
   its DIDs — `accepted`; or when a counted vouch names one of its
   DIDs — it joins the counterpart, and if one of its DIDs is
   named-dead the chains that named it are its `revokedBy`; through
   nothing else. A channel a stranger opened belongs to no
   counterpart until a vouch or an accept brings it in.
2. **A revoke from a live chain** is counted. Every chain that
   contains a named DID gets the revoking chain in its `revokedBy` —
   the start of its death if that was empty, one more revoker if not
   — except a chain the person ruled `dead`, which is dead on their
   word already and gets nothing; a named DID no chain contains yet
   is added to named-dead, with the revoking chain, so the chain that
   later contains it is dead on arrival. A named DID of another
   counterpart's is ignored. A revoke that names its own chain is that
   chain's own leaving, and no challenge is owed. Then `since` (§4):
   every counted vouch by a named chain that was observed after
   `since` is **withdrawn** from the `vouchedBy` of the chain it was
   for, and a chain thereby left with none, that was not accepted and
   is not ruled `live`, has nothing behind it: its own counted
   vouches are withdrawn in turn, until nothing more is. A revoke is
   never withdrawn.
3. **A vouch from a live chain** is counted: the vouching chain joins
   the `vouchedBy` of the chain it names, which appears by rule 1 if
   it is new, and stays there after the voucher's death unless rule 2
   withdraws it.
4. **A rotation** — a `from_prior` signed by a DID of a chain, in an
   envelope sealed by the DID it names — puts the new DID in that
   chain whatever the chain's state: it is the key's own word about
   its next name, and the state is the chain's, not the name's. From
   the chain's end it moves the end; from a DID rotated from already
   it is a **fork**: the new DID is one more of the chain's `heads`,
   the end is the head observed last, and only the end is written
   to. To a DID that is in another chain — one a sibling vouched for
   before its rotation arrived (`devices.md` §5.1) — it is the key's
   word that the two were one, and they are joined: every list of
   the two records unioned, each flag set if either's, `ruled` the
   later verdict.
5. **Any observation on a chain that is not live** — rules 2 and 3
   not applied, a message, a response — goes in its `words`; nothing
   it carries is an edge or a kill, and a rotation it carries is rule
   4's. On a dead chain it is a word from a dead end (§6): `spoke` is
   set, `answered` too if it is a response to a challenge of this
   death, and the chain is added to the `disputedBy` of every chain
   other than itself in its `revokedBy`.
6. **A verdict** sets `ruled` on the chain it names and ends its death
   and its dispute: `revokedBy`, `challenged`, `spoke`, `answered`
   and `disputedBy` are cleared, and later events apply to the record
   as it now is — the next counted revoke starts the next death, owed
   its own challenge. `dead` also removes the chain from every
   `disputedBy` it is in, its revokers' word upheld; `live` removes
   it from none — the ends that revoked it are ruled on their own.

What the fold reports, per chain:

```ts
type End = {
  did: string;                            // the chain's end: its head, or of several the one observed last
  chain: string[];                        // its DIDs, in rotation order
  heads: string[];                        // its DIDs not rotated from; more than one is a fork
  state: "conflict" | "dead" | "disputed" | "orphaned" | "live";  // read off the fields below
  accepted: boolean;                      // the person accepted a channel under one of its DIDs
  vouchedBy: string[];                    // the `by` of every counted vouch for it not withdrawn
  revokedBy: string[];                    // the chains whose counted revokes killed it, this death; [] when a verdict did
  ruled: "live" | "dead" | null;          // the person's last verdict on it
  disputedBy: string[];                   // the chains in conflict that it revoked
  challenged: boolean;                    // some device of the contact's sent it a challenge, this death
  spoke: boolean;                         // it spoke while dead, this death
  answered: boolean;                      // it answered a challenge of this death
  words: string[];                        // what it said while not live, in order
};
```

- `ends[]`: one per chain, in order of first appearance. Several ends
  are several devices; a *fork* — one chain with two `heads` — is one
  end, shown: a key that named two successors, which is a device that
  rotated twice before the contact answered (`devices.md` §9) as
  often as a key that was copied, and the fold does not guess. A
  copied key is retired the one way there is: a sibling revokes the
  chain, and the device comes back with a new key (§1).
- The **write set** is every live end: a message to the counterpart
  goes to all of them (§8). Empty for a counterpart with no live end —
  dead, orphaned or disputed — the person is told, and the incidents
  (if any) are where the answer is.
- **Challenges owed**: every end whose `revokedBy` holds a chain
  other than itself and that is not `challenged`. An orphaned end is
  owed none, nor a chain ruled dead, whose `revokedBy` a later revoke
  leaves alone (rule 2); a chain ruled live and revoked again is owed
  one again.
- **Incidents**: the components of the ends in conflict, the ends in
  their `revokedBy`, and the chains in those ends' `disputedBy`,
  joined until nothing more joins (§6) — each a set of ends the
  application puts before the person together, and the person rules
  on one at a time.
- Every inbound message says which end sent it — the DID the sealing
  key wore — so the application can show the counterpart's devices,
  and beside each message which one, without a name for any of them.

A contact that itself has several devices folds this on each from its
own observations and unions them: a message is one whichever of its
devices saw a copy (§8), so the same vouch, arrived on each's own
channel, is one counted edge, from the earlier of the two sightings;
both may challenge; the last verdict wins. Each copy keeps its
observer's own moment and the edge takes the earliest, so a `since`
that would withdraw the copy one device saw late is answered by the
copy its sibling saw in time — the earlier sighting is the proof that
the vouch predates `since`, and the chain is not orphaned. None of it
needs a rule beyond the contact's own order.

## 8. Sending to many ends

A message to a counterpart is written once and goes to every live end:

- One plaintext, with one `id`; its `to` names every end it goes to.
  One **copy per end**, each sealed to its end, each delivered on its
  own to that end's routing. The plaintext is the same in every copy.
- **The receiver folds copies by id.** Copies of one message that
  reached the receiver on several of its own devices — the sender
  sealed to several keys of the receiver's, one per device — are one
  message, with one id; so are the copies of one outbound to several
  ends, on the sender's side. A message's identity to the receiver
  is the counterpart, the chain it came from and its id: the fold
  acts on it once, at the first copy (§7). Two ends sending one id
  have sent two messages; one end sending two plaintexts under one
  id has sent two, and the reused id is shown. The id is the
  sender's claim and is never a storage identity; the copies keep
  their own.
- **Inbound, on each of the receiver's devices.** A counterpart fans
  out to the receiver's ends the same way; each of the receiver's
  devices receives its own copy. A device that was never reached — the
  counterpart did not have its end yet — reads the message from a
  sibling's copy, which is what the receiver's own sync is for.
- **A message from an end the receiver does not know** — a device of
  the counterpart's that the counterpart has not yet had vouched for —
  is a stranger's until the vouch lands (§3). A message from a dead,
  an orphaned or a disputed end is §6.
- **Side effects, once per device.** A handler that answers a message
  — a profile asked back, a challenge's response — runs on every
  device of the receiver's that got a copy, and each answers from its
  own end, with an id of its own: two devices answering is two
  messages to the party that folds them, not one, and a handler is at
  least once. This protocol's own answers bear it — a second response
  is a second word from a dead end, and there is one `spoke` to set
  (§7) — and which of the receiver's devices answers anything else
  is its own arrangement (`devices.md` §5.4). What no device acts on
  is a word from a dead, an orphaned or a disputed end (§6).

The counterpart's mediators are told nothing new: each copy is a
forward to the routing of the end it goes to, as a single-device
message was. A counterpart whose devices share a mediator gets N
forwards to one service; that mediator sees N envelopes to N recipient
keys, as it would from N different senders.

## 9. What a contact can see

Each contact sees how many ends of a counterpart it holds, when each
appeared and was vouched for, and when one was revoked, by which, and
from when;
it sees which end each message came from. It sees no device id, no
label, no key name and no sibling's DID toward anyone else, and two
contacts comparing what they see find only that each holds N chains of
an identity — the same N, changing at the same moments, which is the
one correlation this design accepts, as it accepts that a contact sees
which mediator each device uses. Nothing here changes what the
mediators see: N recipients where there was one, each registered by
its own device, each forwarded to on its own.

## 10. Versioning, open

- **Version.** `devices/1.0` is a DIDComm protocol and versions as
  such. A message of an unknown type in it is answered with a problem
  report, as any unknown type is.
- **A contact that does not speak `devices/1.0`** folds no vouch: the
  counterpart's other devices are strangers to it and stay so. Toward
  such a contact the counterpart is one device — whichever it attached
  — and a change of device is what it was before this protocol: a
  `from_prior` rotation from the device it knows to the one replacing
  it, a replacement, not an addition, done by the old device while it
  still can. The problem report for an unknown type is what tells the
  vouching device so.
- **A signed vouch.** The envelope is the proof (§3) and the contact's
  own fold the only reader; a JWS inside — the shape `from_prior` has
  — would let a third party check it, and is what a vouch by a key
  that never seals an envelope (a pre-committed successor to a lost
  identity, `devices.md` §8) will need. Add it then, as an optional
  `proof` on `vouch` and `revoke`.
- **Vouches by a compromised device** are bounded by `since` (§4): a
  device that was stolen and, before it was dropped, vouched a
  stranger's key toward a contact has planted an end that the revoke
  orphans, provided `since` is before the vouch reached the contact —
  which is why `since` is the last moment a sibling heard from the
  device, not the moment the person noticed (`devices.md` §5.2). A
  vouch that reached the contact before that moment stands, and the
  end is one more to retire by hand, listed under its introducer.
  Not in this version: a primary device that alone may vouch, which
  is how the services that share this model close the hole entirely.
  Not in any version: a rule that reads the *structure* of the
  vouches — "live iff some voucher is live" — which the contact
  cannot use. Every end an identity has was introduced by the device
  it had first, so structure alone cannot tell the sibling from the
  stranger once that device is dead; a one-hop reading is passed by a
  thief with two keys vouching each other, and a rooted reading
  darkens every honest identity that loses its first device. What
  the thief cannot forge is when the contact saw the vouch, and that
  is what `since` reads.
- **Two clocks.** `since` is the sender's wall clock and is matched
  against the contact's. A skew larger than the gap between the last
  honest word and the theft lets a vouch through or withdraws one it
  should not; a sibling's re-vouch mends the second, nothing mends the
  first, and a `since` set earlier than needed is the safe error.
- **A dispute is a freeze.** An end that is dead and speaks puts the
  ends that revoked it in dispute (§6), so a thief holding a revoked
  device that answers its challenge stops every contact writing to
  the honest devices until each contact rules. Availability is traded
  for confidentiality on purpose: the contact holds two ends that each
  say the other is not the counterpart's, and to go on sealing to
  either is to pick the side the evidence does not; the ruling is one
  question, and the call it takes is the one the conflict asks for
  anyway. Without the freeze, the honest device that was revoked
  first has no counted word left — its own revoke of the thief's
  device arrives as a word from a dead end — and the thief's end
  stays the only one written to.
- **Replay.** DIDComm has no replay protection of its own: a
  mediator, or anyone holding an envelope, can deliver it again. A
  copy applies nothing (§7), so a revoke delivered again undoes no
  verdict, a vouch delivered again adds no edge, and a message an end
  sent while live, delivered again after its death, raises no
  dispute — a mediator cannot freeze a contact by itself. What a
  replay can do is deliver a message for the first time late, and a
  vouch that arrives late is what `since`, matched against the
  contact's own clock, is for.
- **A fork.** Two heads of one chain are two successors one key
  named, and the fold keeps both and writes to the later (§7): it
  cannot tell a device that rotated twice unanswered from a key that
  was copied, and a copied key can do already what a fork does. A
  verdict that picks a head is not in this version; a sender that
  signs `from_prior` from the last of its DIDs that reached the
  contact's mediator, not the last the contact wrote to, leaves
  honest forks to lost messages (`devices.md` §9).
- **Timeouts** are the application's throughout (§5): nothing in the
  fold expires.
