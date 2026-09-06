# Estoc Relationship and Address Policy Profile 1.0

Status: **draft, phase 1** — ordinary DIDComm relationships, discovery and
early private-address allocation for one active writable vault runtime.
Multi-replica mediation and vault synchronization are deferred.

This document uses **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**
and **MAY** as described in BCP 14 when they appear in all capitals.

There is no Estoc rendezvous wire protocol, connection request, accept or
decline. Messages use ordinary DIDComm protocols. Relationship formation is
independent of whether either address was public or allocated for private use.
An address change uses standard `from_prior` inside an existing relationship.

## 1. What it is for

A relationship has an unordered pair of birth addresses, one stable ID and
two independently replaceable ends. Public/rendezvous and pairwise describe
disclosure and allocation policy. They do not select different event schemas,
sender permissions, receive paths or relationship-ID formulas.

```text
R: A0 <-> B0       either party may send first
R: A1 <-> B0       A changes its address in R
R: A1 <-> B1       B independently changes its address in R
```

Every transition preserves R and its message/effect identity. Either end can
retain its public address. One address may participate in several relationships;
each relationship changes it independently. The default Estoc policy prefers
fresh pairwise addresses early, using the same rotation procedure as later
address changes. It does not impose that policy on peers.

The initial message may already contain useful application content. When no
content is available, Trust Ping 2.0 is the interoperable default. An ordinary
reply can precede any private-address allocation or rotation confirmation.

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Out-of-Band 2.0 (`https://didcomm.org/out-of-band/2.0`);
- Trust Ping 2.0 (`https://didcomm.org/trust-ping/2.0`);
- Empty Message 1.0 (`https://didcomm.org/empty/1.0`);
- Report Problem 2.0 (`https://didcomm.org/report-problem/2.0`) when a
  remote Report Problem response is received;
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Peer DID Method numalgo 4;
- RFC 8785 JSON Canonicalization Scheme;
- `distributed-delivery/1.0`; and
- `vault-events.md`.

Phase 1 uses ordinary Coordinate Mediation and account-scoped Message Pickup
when a mediator is used. `replica-mediation/1.0` and `vault-sync/1.0` are
informative deferred extensions, not dependencies of this profile.

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

## 3. Terms

- **Communication address** — a DID with supported authentication/key-agreement
  evidence and delivery information. Local addresses are seed-derived
  `did:peer:4` entities; external addresses may use other supported methods.
- **Public / rendezvous address** — an address disclosed for discovery. This
  is a policy description, not a core DID role.
- **Pairwise address** — a fresh address allocated for use in one relationship.
  The allocator avoids reuse; core relationship lookup always uses both ends.
- **Birth addresses** — the immutable canonical DID pair used to derive `R`.
- **Relationship** — the stable symmetric `R`, its pinned initial evidence and
  its two address histories. Its local/peer orientation is a vault-local view.
- **Birth intent** — an ordinary outbound whose nullable `birth` metadata
  freezes a new address pair before network work. It is not a wire message type.
- **Root-address receipt** — the binding-root input defined in `vault-events.md`
  section 14.9 for invitation consumption, irrespective of address policy.
- **Application input** — authenticated scoped input other than a control
  observation, Empty, Trust Ping `ping-response` or Report Problem. Excluding
  these types from privacy-response selection prevents reply cycles; it does
  not exclude their receipt, binding or scoped ACK processing.
- **Rotation notification** — an ordinary message disclosing a committed local
  transition. It is not a prerequisite for relationship formation.
- **Rotation confirmation** — authenticated scoped input addressed to the
  exact successor; explicit ACK receipt information remains separate.

## 4. Invariants

1. `R(A, B) == R(B, A)` for the same canonical birth addresses. Endpoint
   direction, key selection and public/private allocation do not enter the ID.
2. A DID/key is authenticated before its message can authorize effects.
3. Every otherwise valid new address pair can form a relationship at a live
   local address, without contact admission or a private-address requirement.
4. Existing address histories and verified `from_prior` continue the same R.
   A known missing/conflicting continuation never falls back to a new birth.
5. A local or peer transition replaces one end only inside its named R.
6. Same proof/edge is idempotent; competing branches and ambiguous address-pair
   claims are visible conflicts. Event arrival order chooses no winner.
7. Birth binding, contact assignment and local rotation are separate events.
8. Public addresses may send and receive ordinary relationship traffic.
9. Fresh pairwise allocation and early notification are local privacy policy.
10. A submitted message ID is never automatically prepared or submitted again.
11. Contact deletion and erasure preserve identity and consumed invitations.
12. Phase 1 has one active full runtime; peers and mediators address DIDs,
    never replica IDs or vault-local relationship IDs.

## 5. DID profiles and resolution evidence

### 5.1 Common requirements

A locally controlled communication DID MUST have its fixed key-agreement and
authentication methods, seed-derived keys, validated numalgo-4 document and one
immutable `boundRouteId` under `vault-events.md` section 5.2. That document must
support authenticated messages and signing `from_prior`. Recipient lifecycle
is role-independent under section 9; sending and new births require a live DID.

Before the first package is submitted, its sender MUST durably retain:

- the exact presented peer DID;
- the canonical peer DID;
- the exact RFC 8785 canonical resolved DID document under its raw DASL CID;
- the selected authentication `kid`;
- the selected key-agreement `kid`; and
- the resolution event ID.

This is the root binding snapshot used later to verify
`from_prior`. A current resolver result MUST NOT silently replace it. A later
resolution may recover missing bytes only when the raw CID of its canonical
document bytes equals the pinned document CID.

An external peer or mediator may use `did:web`; resolving it does not create a
locally controlled DID entity or a document-publication obligation. A Web
resolver used by a mediator or client MUST be constrained against SSRF, DNS
rebinding, redirects to forbidden networks, unbounded responses and DID
mismatch. Failure to resolve safely is deferred or reported as
`did-resolution-unavailable` only for the transient failures classified below.
A policy-forbidden fetch is a definitive failure; no failure falls back to an
unrestricted fetch.

For an external Web rendezvous target, the sender pins the exact Web
document revision before first submission and later verifies `from_prior`
against that snapshot even when the currently published document has changed.
Key IDs are taken from that exact authorized document, not synthesized from a
vault key-generation naming convention.

Remote senders may use either a public DID, including
`did:web`, or a Peer DID. The receiver verifies the sender's exact DID spelling
and authorized key-agreement method under its supported resolver; it MUST NOT
require the peer to create a pairwise DID. An unsupported sender method fails
authentication and is terminal under section 9.2; unavailable resolution
defers receipt without pickup ACK within this section's sender-resolution
budget under section 9.1. Numalgo-4 first-disclosure requirements apply only
when that method is used. A same-DID authenticated
reply from any key authorized by the pinned initial document needs no
`from_prior`; a different DID requires verified continuation evidence to join
the relationship.

This section owns recipient-resolution freshness. A `did:peer:4` recipient
uses its retained, validated long-form document and needs no fresh resolution.
For every other supported DID method, the preparer MUST resolve after the
new outbound intent commits and commit that fresh `peer.resolved` before its
first package. Do this for each new message ID, including later sends in the same relationship;
an earlier outbound's snapshot, a local TTL or a resolver's stale/offline cache
cannot satisfy the requirement. An online conditional revalidation that
confirms the same document is sufficient and produces a new resolution event.
If no first package committed before interruption, repeat resolution on resume.
Unavailable resolution keeps the outbound retryable; it is not evidence of a
key change. Freshness is a producer ordering rule, not a clock comparison in
the portable fold.

Once a package exists, retry does not re-resolve and uses its exact bytes.
Permitted repacking of that message ID reuses its retained snapshot, or the exact
carrying-inbound snapshot of a committed verified continuation to a new peer
end; it never obtains a fresh document merely to replace a pinned key or route.
First-package resolution uses the failure classification below, including
the outbound `peer-key-changed` result. A fresh resolution remains evidence for
current preparation, never authority to extend a relationship's chain.

This section also owns sender-authentication freshness. A `did:peer:4` sender
authenticates against its validated long-form document, retained or supplied
with this disclosure. For every other supported method, whenever a delivery
enters or resumes authentication under section 9.1, the receiver MUST resolve
the presented sender DID and authenticate its authcrypt key against that
current document. Redelivery during a relationship-evidence wait follows the
suspension rule below. Online conditional revalidation is sufficient; a local
TTL or stale/offline cache is not. A retained
`peer.resolved` may be reused only when that freshly validated document's raw
CID equals its `documentCid` and its `localKeyName`, `peerPublicKey`, `did` and `presentedDid`
match the observation; otherwise commit new evidence before `message.in`.
A key absent from the current document fails section 9.2 even when it belongs
to `peerChain(R)`: the chain scopes already authenticated observations, it does
not authenticate new ones. Unavailable resolution defers without pickup ACK
only within the budget below; it cannot fall back to a stale snapshot.

For both sender and recipient resolution, **unavailable** means there is no
definitive answer now: a network/transport failure, timeout, temporary resolver
failure (`internalError` / `INTERNAL_ERROR`), or a retryable HTTP response
(408, 429 or 5xx) from the derived `did.json` resource. A definitive resolution
result takes precedence over its transport status: an intermediary resolver's
HTTP 500/501 carrying a malformed-document or unsupported-method result does
not turn that result into temporary unavailability.

A DNS NXDOMAIN response for the derived `did.json` authority, or NODATA for
all usable address families after alias resolution, is a definitive failure.
NODATA for one address family alone does not fail an otherwise usable address.
SERVFAIL, DNS timeout, connection timeout or refusal, and TLS validation
failure are unavailable; none permits bypassing TLS or the resolver policy.

A definitive failure includes not found or deactivated (including a derived
`did.json` 404/410), an invalid DID or document, an unsupported method, a
document ID inconsistent with the exact presented DID, a key absent from that
document, and resolution forbidden by the SSRF/resource policy above. These
categories include the corresponding
[DID Resolution errors](https://www.w3.org/TR/did-resolution/#errors), whatever
the resolver API's spelling. For inbound sender authentication they are
terminal section-9.2 failures: pickup-ACK when mediated and create no
`message.in`. Only unavailable answers defer, within the inbound budget below.
For first-package recipient resolution, definitive failure records
message-scoped terminal
`delivery.failed(code="peer-key-changed", packageId=null)` without preparation
or a new binding, including for a first send; unavailable answers keep
the outbound retryable. Missing retained historical evidence still follows
the separate recovery rule and is not a definitive new-resolution result.
Other completed unsuccessful resolution results are definitive for that
attempt; a policy refusal MUST NOT be disguised as transient unavailability.

The `peer-key-changed` code also covers definitive first-package resolution
failure when no earlier peer key exists. User-facing text MUST NOT describe
every such result as an observed key replacement; use the bounded local
resolution diagnostic, or a neutral peer-resolution failure label when that
diagnostic is absent. This does not add a portable diagnostic payload.

**Inbound sender-resolution budget.** Once local receive prerequisites are
satisfied, the runtime MUST use finite per-attempt timeouts, a finite attempt
budget and local backoff with a finite cap for each delivery. It SHOULD use
section 14's retry-interval, backoff-cap and attempt-count defaults, applied
to resolution calls rather than transport submissions; the outbound wire
expiry rule does not apply. Count an attempt before invoking the resolver,
including failure and unknown outcomes. While receive-ready, schedule retries
without waiting for another delivery or an external resolution-change signal.

A retention stop bounds only the active resolution sequence. At its first
attempt, if a known absolute mediator delivery-retention deadline is still in
the future, the interval from that attempt to the deadline caps active elapsed
time; a past or unknown deadline supplies no such cap. An advertised
retention duration also caps active elapsed time, measured from the first
attempt. Active elapsed time includes resolver calls and backoff, but excludes
all non-resolution deferral waits under section 9.1, including interruptions
after the first attempt. Time before the first attempt never counts. A past
deadline alone never makes a delivery the mediator still delivers terminal;
unknown retention or lost local state still requires a finite attempt budget.
These are local resolution stops, not changes to the mediator's actual
retention, and require no cumulative delivery-lifetime wait history.

All workers share accounting for the same local mediation and pickup-delivery
attachment ID; a profile with replica-scoped pickup also includes that replica
ID. Direct input uses its normalized envelope CID in the local receive context.
Redelivery and reconnect MUST NOT reset this accounting or start parallel
budgets. An evidence-change retry after a relationship-evidence wait starts a
fresh sequence only as specified below. The accounting is local scheduling
state, not a portable event; runtime restart, restore or loss of local state
may reset it as in section 14. A retained relationship-evidence wait still
requires a relevant evidence change before retry. If the delivery's wait
state was also lost, redelivery re-enters ordinary receive/authentication
gates; retained relationship claims still govern selection after
authentication.

When the budget or retention stop is reached without a definitive answer,
classify that delivery as terminal input under section 9.2: pickup-ACK when
mediated, no `message.in`, contact or response effect, and at most a bounded
local diagnostic. Exhaustion does not prove a key change or permanently reject
the DID; the sender may make a new explicit attempt under ordinary sending
rules. It never authorizes automatic retry of a submitted message ID. A successful
resolution within budget instead proceeds through normal authentication and
durable receipt. Locked-vault, incomplete-recovery, recoverable local
key/route/historical-evidence and relationship-evidence deferrals under section
9.1 suspend this accounting: do not schedule resolution calls or apply this
terminal path while the delivery remains in such a wait. This bounds an
unresolved authentication attempt, not the age, expiry or acceptance time of a
valid initial message.

While local wait state is retained, mere redelivery or reconnect of a delivery
waiting for relationship evidence is not a retry: keep it pending without
reauthentication, resolution attempts or pickup ACK. When section 9.1 permits
retry because evidence relevant to the blocked pair changed, reapply
authentication with a fresh bounded resolution sequence if the sender method
requires resolution. All workers for that delivery share this sequence.
Neither unrelated nor relevant evidence changes restart an active sequence;
it first completes or fails.
If authentication succeeds but relationship selection still lacks evidence,
return to the wait. Time in relationship-evidence waits consumes neither the
attempt budget nor the retention stop defined above. After retry begins,
unavailable answers consume the fresh budget and can exhaust it; a definitive
failure is terminal as usual. Waiting or redelivery alone cannot cause that
outcome.

These rules also apply to duplicate deliveries that would create a new
observation. If interruption occurs before inbound commit, resolve again when
the delivery resumes authentication under section 9.1, even if resolution
evidence already committed. Recovery or import of an already committed
observation verifies its retained evidence without a new
network resolution; a later revocation does not invalidate historical receipt
or scope. As with recipient freshness, this is a producer ordering rule, not
an event-time or fold-clock test. Historical `from_prior` verification still
uses its pinned predecessor snapshot independently of current sender
authentication.

A key change under the same canonical peer DID without verified continuation
is not continuation of an existing relationship. Phase 1 uses the following
policy; a fresh `peer.resolved` never extends `peerChain(R)`:

- For a new package to an existing relationship's peer DID, including a later
  send, select an authorized key already in `peerChain(R)` under
  `distributed-delivery.md` section 9, with the canonical DID and key matching
  the same pinned or verified transition snapshot. If a successful fresh
  resolution offers no usable key with that evidence, or resolution fails
  definitively under the classification above, append message-scoped terminal
  `delivery.failed(code="peer-key-changed", packageId=null)` before preparation.
  Do not append an incompatible package or binding and
  do not mark the whole relationship conflicted. Resolution unavailability
  remains retryable. An already prepared package continues to use its
  exact retained snapshot; it does not re-resolve to replace its key.
- For an authenticated inbound addressed to any historical local address of `R`,
  whose canonical sender DID equals `currentPeerDid(R)` but whose key is outside
  `peerChain(R)` and which carries no `from_prior`, preserve the observation
  and exact resolution evidence but derive no execution scope. Process no ACK
  or effect. Surface a `peer-key-changed` diagnostic under
  `vault-events.md` section 14.6 instead of silently waiting for more evidence.
  A superseded sender node first follows section 9.3's receipt rule.
  Missing binding/chain evidence remains ordinary deferral; an invalid carried
  proof follows the existing conflict rule, not this no-proof path.
- To restart without a valid peer rotation to a different DID, use an explicit
  new send using a fresh local communication DID, producing a new
  relationship and binding. Do not rewrite the old binding or replay its messages.
  A different selected transport key never changes the address-pair ID. A
  carried or committed continuation uses section 12; repeated DID strings do
  not replace the required authorization evidence.

Missing historical snapshot material is a deferred verification state, not
proof that a rotation is invalid.

### 5.2 Peer DID numalgo-4 profile

Every local communication address is a Peer DID numalgo 4. Both validated long
and canonical short forms name one entity. Canonicalization validates the long
form and uses its derived short form. The retained resolution document follows
`vault-events.md` section 11.1's fixed long-form representation, including when
the presented DID is short. Supported non-Peer methods use their method-defined
canonical DID, with no inferred aliases from names, common keys, resolver
redirects or service endpoints.

For `did:web` and any other supported method that defines no canonical form,
the canonical DID is the exact presented string. Apply no case folding,
percent-decoding, IDNA mapping or trailing-dot normalization to DID identity;
spellings that differ in any byte are distinct DIDs. A resolver may perform
the method's URL/DNS processing internally but MUST retain and compare the
original DID string. For `did:web`, the returned document's `id` MUST equal
that string byte-for-byte; do not rewrite a mismatching document to make it
match. This fixes the comparison used by the
[did:web resolution procedure](https://w3c-ccg.github.io/did-method-web/#read-resolve)
without changing how it derives the fetch URL.

First disclosure of any local address uses its long form, whether in OOB or
plaintext `from`. Within each relationship, a root sender MUST use its long
form for every package until authenticated scoped input arrives at that exact
address in that relationship. A successor uses its long form and the frozen
proof until its own confirmation in that relationship. Confirmation in another
relationship does not satisfy either condition, even for a shared public
address. Later messages in the confirmed relationship may use the short form;
they do not rewrite the retained predecessor spelling. Application `to`,
Routing `forward.next` and mediator registration use the canonical short form
once the peer document is known. Registration is verified before disclosure.

For authcrypt, plaintext `from` and the DID portion of protected `skid` are
byte-identical; decoded `apu` is the exact UTF-8 `skid` string. If the library
represents the sender only through `apu`, its DID portion still equals `from`.
The fragment identifies an authorized key-agreement method in that exact
document. Do not mix long and short forms in one package. A short form with no
known long-form document fails authentication; it does not create a relationship.

The predecessor's exact first-disclosure long form is used for `from_prior.iss`
and its protected authentication `kid`; `sub` uses the successor's long form.
A receiver compares predecessor DID spellings and authentication-method IDs
under `vault-events.md` section 11.2, using only the method's validated spelling
equivalence and the pinned document. Exact wire spellings remain retained.
A successor may bind another route or mediation for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

## 6. Out-of-band discovery

OOB, QR, directory, file, NFC or manual exchange discloses an ordinary address.
Reusable discovery SHOULD use an address allocated for public contact rather
than reveal one used privately. This policy is enforced at disclosure, not by
introducing different receive or relationship types.

```json
{
  "type": "https://didcomm.org/out-of-band/2.0/invitation",
  "id": "019b2a57-a947-7502-8fee-4d80d949dbcb",
  "from": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
  "body": { "goal": "Write to Alice" }
}
```

An OOB identifier supplies `pthid` for an interaction following that invitation;
it is not a relationship ID. One-use disclosure is consumed at matching durable
root-address receipt under `vault-events.md` section 14.9, independent of
contact creation, rotation or response. Tombstones and erasure do not reopen it.
Repeated input by the same R reuses consumption; different consumers conflict.

## 7. Address lifecycle

All addresses use `did.created`, `did.disclosed` and `did.retired`. Keys, Peer
document and bound route are immutable. Retirement stops new sends, disclosure
and relationship births at that address. Existing relationships retain its
historical recipient membership while the route remains receive-eligible.
Route/mediation retirement and configuration conflicts are terminal; temporary
outages are recoverable. These rules do not inspect public/pairwise policy.

Rotation changes one relationship's current end. It does not retire a shared
address, replace another relationship's address, rewrite an invitation or edit
an existing route. Keep old and new recipient routes through confirmation;
retire resources only when no other relationship or disclosure requires them.

## 8. Ordinary sending and birth selection

`vault-events.md` section 9.2 owns the outbound schema. Every send freezes one
`relationshipId`. A contact or address selection API determines that R
under the writer lock before intent commit, using existing address histories
first. For a new pair, nullable `birth` freezes the local DID entity and exact
peer DID spelling, allowing an offline send before resolution. These birth
addresses identify R permanently; later packages use its current ends.

No first reply, admission, handoff or private DID is required to send ordinary
messages. A root public address is eligible on either side. The default local
initiator SHOULD allocate a fresh private sender before selecting a new pair;
the API may explicitly choose another live address. This is a sender-selection
policy, not a restriction on relationship formation or interoperability.

### 8.1 Common requirements

All messages follow DIDComm authentication, exact recipient-method checks and
the ordinary content/header rules in `distributed-delivery.md`. There is no
initial-specific size, message-type, age or lifetime acceptance policy. Hard
parser/resource limits and integrity checks remain. Missing `please_ack` or
`response_requested == false` does not prevent durable receipt or binding.

### 8.2 Default Trust Ping

When no application content is ready, send an ordinary Trust Ping:

```json
{
  "type": "https://didcomm.org/trust-ping/2.0/ping",
  "id": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "from": "did:peer:4zQm...bob-long:z...input",
  "to": ["did:peer:4zQm...alice-short"],
  "body": { "response_requested": true }
}
```

A false `response_requested` prohibits `ping-response`. It does not prohibit
a separate address-change notification under section 11, whose purpose is
disclosing a locally selected rotation. Receipt alone does not request an ACK.

### 8.3 Content-first communication

Any supported application protocol may be the first message, including Basic
Message, with its normal body, thread and attachment semantics. No rendezvous
wrapper, extra wire relationship field or preliminary handshake is required.
Content remains application content regardless of whether a rotation is carried.

### 8.4 Select addresses and commit intent

1. Select a live local address and exact peer address, choosing a fresh private
   local address by default for a newly initiated relationship.
2. Look up their canonical pair in committed relationship histories and queued
   birth selections. Reuse a unique R; defer missing evidence and expose conflicts.
3. For a genuinely new pair, derive section 10's R and freeze `birth` metadata.
4. Commit content, `message.out` and any selected `relationship.contactAssigned`
   decision. This operation performs no DNS, resolver, mediator or socket work.

### 8.5 Prepare and send

1. Check submitted/expiry/conflict/lifecycle predicates before network work.
2. Resolve the selected peer under section 5.1 and retain `peer.resolved`.
3. Under the writer lock defined for receive and outbound binding operations
   in `vault-events.md` section 12.1, recheck the pair and, for an unbound birth,
   commit the common `relationship.bound`. If a reverse-direction incoming
   message has already bound that pair, reuse its
   binding and pin; a fresh resolution controls key selection under section
   5.1 and does not propose a competing pin. Missing evidence defers and an
   existing binding/index conflict blocks preparation.
4. Prepare a package in R using its current ends, required spelling and proof.
5. Verify local recipient registration before first disclosure, submit, and
   commit `delivery.submitted` on acceptance.

Until submission, permitted repacks preserve message ID, intent and R. Birth metadata
does not prevent repacking after a verified local or peer rotation. After
submission no duplicate, lost ACK or later address change reopens the message ID.

## 9. Uniform receipt

### 9.1 Deferred delivery

A mailbox delivery remains pending, with no pickup ACK and no `message.in`,
only for the following unresolved prerequisites for safe classification,
authentication or relationship selection:

- the vault is locked, recovery is incomplete, or the local key index is not
  yet authoritative;
- a recipient `kid` maps to an exact known local **key-agreement** method, but
  required key/document/route state is temporarily unavailable or route
  reconciliation is pending;
- required historical evidence for that exact known method is temporarily
  unavailable;
- current sender resolution is transiently unavailable under section 5.1 for an
  otherwise eligible local recipient and its per-delivery budget is not
  exhausted; or
- an authenticated delivery cannot select its binding or required transition
  because its exact address pair has known pending membership or missing
  relationship evidence under `vault-events.md` section 12.1. That section's
  unresolved proof carriers allowed to commit with a null binding are not
  blocked from durable receipt by this rule.

Sender-resolution exhaustion uses section 9.2's terminal path; time in the
other deferral waits consumes no sender-resolution budget.

Once local key state is authoritative, the implementation MUST compare the
complete recipient `kid`, including DID and method fragment/purpose. A foreign
DID, a locally controlled DID with a nonexistent fragment, an authentication
fragment used where key agreement is required, any
DID with a terminal bound-route dependency, or a recipient set containing no
eligible local key-agreement method is not deferred. It is terminal
wrong-recipient input. A retired DID retained in an existing local relationship
history can still receive under section 9.2.

A phase-1 runtime retries local-prerequisite deferrals after its local state
changes. Sender-resolution deferrals follow section 5.1's scheduled bounded
retry and terminal-exhaustion rules. A relationship-evidence deferral retries
when verification, import or recovery changes evidence relevant to the blocked
pair, reapplying the ordinary receive/authentication gates with a fresh
section-5.1 resolution budget when needed. If a permitted retry needs delivery
bytes no longer held locally, it MAY obtain them through the next pickup;
that redelivery performs the already-permitted retry. While local wait state
is retained, mere redelivery or reconnect without a permitted retry does not
restart authentication; loss of that state follows section 5.1's
receive/authentication rule.
The wait consumes no sender-resolution budget and has no client retention cap;
section 5.1 excludes this waiting time from the retry's local retention stop.
Elapsed waiting time alone never makes the delivery terminal.
Safe evidence selection permits receipt; a proven conflict or another safely
classified terminal condition follows section 9.3. A mediator may independently
expire the waiting delivery, but that does not clear the pair's pending claim
or permit a new birth. A future sync-enabled runtime may sync and refold first.
It MUST NOT treat a locked vault or incomplete recovery as proof that the
recipient is foreign.

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. An exact local key-agreement method is eligible
for receipt when its DID/key mapping is valid and conflict-free, its bound
route has no terminal dependency, and its DID is either live or retained in an
existing relationship's local history. Missing
recoverable prerequisites defer under section 9.1. If no recipient `kid`
identifies an eligible or recoverably pending method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

Input to an eligible retired local key MUST pass through ordinary
decryption, authentication and durable receipt. It does not require renewed
recipient registration. Scope derivation is unchanged; current tombstones and
the availability of a usable local sender under `distributed-delivery.md`
section 8.1 still govern subsequent work. Its mediation stays in the required
receiving set under `vault-events.md` section 14.2 while its bound route
remains configured, non-retired and conflict-free and the mediation is usable.
Contact tombstones still apply under that document's section 16.6.

For an exact local recipient that can be decrypted, the receiver then checks
only conditions needed to classify the input safely before writing portable
application state:

- recipient eligibility above, exact key-agreement method and valid bound route;
- valid DIDComm syntax and authenticated encryption;
- a supported authenticated sender DID under section 5.1, with matching
  `from`/`skid`/`apu` and valid first-disclosure long form for numalgo 4;
- per-source and per-recipient abuse rate limits; and
- emergency raw-ingress/storage exhaustion limits.

An implementation MUST NOT use this gate for a local preference about message
type, initial-specific size/lifetime limits, message age or expiry,
relationship or recipient capacity, absence of current-message `please_ack`,
or Trust Ping `response_requested == false`. Ordinary parser/transport limits
and concrete resource exhaustion still apply, without a separate bootstrap
floor or ceiling.

A safely classified hard rejection received through Message Pickup:

- MUST be pickup-ACKed;
- MUST NOT append `message.in`;
- MUST NOT create a contact, relationship or response effect; and
- MAY leave only a bounded local diagnostic.

Direct transport has no pickup ACK. Malformed crypto, wrong recipient,
an unbound retired recipient, a definitively unresolvable sender DID, exhaustion of
section 5.1's sender-resolution budget, section 9.3's superseded-sender
rejection and hard abuse/resource limits are examples of this gate.

### 9.3 Integrity checks and durable receipt

Network resolution and authentication finish before taking the receive lock
defined in `vault-events.md` section 12.1. Under that lock, every local recipient
follows that document's sections 12.1 and 14.4's pair lookup. A carried proof
uses its predecessor only as a lookup hint until verified; a proof-free
successor freezes its exact committed transition reference. A new proof-free
pair binds actual canonical addresses,
never a recipient role or selected sender key. New births at retired addresses
are terminal. Known missing/conflicting membership cannot become a new birth.
In particular, an unresolved committed proof carrier can keep its exact
local/sender pair pending under `vault-events.md` section 12.1; a later
proof-free input does not bypass that pending membership.

Recheck exact recipient eligibility, binding/intent integrity, contact tombstones
for new interaction and one-use invitation availability. After authentication
and pair lookup, apply this producer-time rule using the committed state at
that instant: if the canonical authenticated sender is a node of the unique
R's peer history other than `currentPeerDid(R)`, a delivery without an already
committed observation with that observation message ID in R is terminal input
under section 9.2. Pickup-ACK it when mediated; create no `message.in`, contact,
relationship, ultimate ACK or response effect, and at most a bounded local
diagnostic. This applies with or without a carried proof and implements
[DIDComm DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation).
Unresolved or conflicting lookup still follows the missing-evidence/conflict
rules; another relationship sharing the old DID is not rejected merely for
this R's rotation.

A delivery matching such an existing message ID group follows ordinary duplicate and
integrity handling, including conflict recording for contradictory evidence.
Matching only a wire ID or thread is insufficient. It creates no new response
obligation; only existing eligible unfinished work may resume under
`distributed-delivery.md` section 8.4. Current sender authentication is still
required for the delivery.

For input passing these checks, commit or reuse the exact resolution first.
When a new binding is needed, commit it in a separate `Vault.commit` and obtain
its returned `eventId`; only then commit `message.in` with that `relationshipBindingEventId`
and its other immutable evidence references. Keep the receive lock across
these dependent commits, releasing it before network acknowledgment work.
A crash after resolution or binding but before inbound commit leaves reusable
evidence, consumes no invitation and creates no pickup or ultimate ACK.
On redelivery, repeat authentication under section 5.1 and
reuse the binding. Safely identified integrity rejection is terminal without
new input or response effect.

Duplicates reuse known consistent identity. Eligible retired historical
recipients may record late input for cleanup, but neither duplicates nor new
receipts resurrect deleted contacts or restart submitted effects. Contradictory
duplicates conflict. The superseded-sender check above is never reapplied to
committed observations during fold, recovery or import; later transitions do
not invalidate their historical scope or unfinished work.

Durable `message.in` and its resolution/binding evidence precede pickup ACK.
Carried proof verification and committed transition evidence precede explicit
ACK processing and all application effects. A carrier whose binding is still
unknown remains effect-deferred until its transition supplies it. Recovery uses
the saved evidence, without inventing a new relationship, contact origin,
invitation consumption or receive-time policy decision.

## 10. Symmetric relationship identity

This section owns relationship and default privacy-allocation ID derivations.
Let A and B be the distinct canonical *birth DID strings*. For numalgo 4,
validate a supplied long form and use its short form. Other supported methods
use section 5.2's canonicalization. Sort the two strings by unsigned UTF-8 byte
order; encode the resulting array with RFC 8785. No locale collation, Unicode
normalization, resolver-dependent aliasing or public-key sorting is implied.

```text
[lo, hi] = sortCanonicalDids([A, B])

relationshipId    = UUIDv5(
  estocNamespace("relationship"),
  RFC8785(["v1", lo, hi])
)

contactId         = UUIDv5(
  estocNamespace("relationship-contact"),
  RFC8785(["v1", relationshipId])
)

earlyPrivateDidId = UUIDv5(
  estocNamespace("relationship-local-did"),
  RFC8785(["v1", relationshipId, canonicalLocalBirthDid])
)
```

Both send directions derive the same R. The local birth address distinguishes
the two ends' default private entity IDs. A vault's seed separately determines
the keys. The private DID is an optional successor, not a birth-address input;
there is no circular derivation. Ordinary later rotations use fresh UUIDv7 IDs.

Identifier fixture (not a live resolver or JWT fixture):

```text
A                  = did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd
B                  = did:web:bob.example
relationshipId     = 35807a1e-3b8a-52f5-9580-29cd5265882e
contactId          = e0d4f3cf-e4d1-5774-b273-cbe08b2d26dd
earlyPrivateDidIdA = 4734b126-9706-5c8f-b971-91a5afb9c1d4
earlyPrivateDidIdB = 30d9a3a6-0e65-52a4-a822-591a683bb1e6
```

This second identifier-only fixture puts the higher-sorting endpoint first:

```text
A                  = did:web:zoe.example
B                  = did:web:amy.example
RFC8785(["v1", lo, hi]) = ["v1","did:web:amy.example","did:web:zoe.example"]
relationshipId     = 249fc438-75bc-53a9-904d-99d44edd6d23
contactId          = cbe762f9-132c-572d-bb0e-bc88efd1fb82
earlyPrivateDidIdA = 6d4670d0-42a0-5978-9030-072fd06f45f0
earlyPrivateDidIdB = 20d9f6a9-8383-5c09-8134-a52954217b3b
```

For each fixture, run the relationship derivation for both `[A, B]` and `[B, A]`
and require its published result. Keys selected from the same DID document do
not change it. A different canonical DID pair yields a different birth. Only the birth uses
this formula: A0-to-A1 and B0-to-B1 transitions preserve the original R, even
though deriving a new birth from `[A1, B1]` would give another value.

The model has one relationship for the same address pair; protocol threads
provide multiple conversations. Two independently selected fresh pairs need
not denote the same relationship merely because the humans are the same. A
pair already claimed by another R through rotation is an index conflict under
`vault-events.md` section 14.4, not permission to merge protocol identities.

### 10.1 Contact IDs

Explicit user contacts use UUIDv7. Automatic contact creation for a relationship
uses `contactId` above, unless that R already has a contact assignment. Reuse
the selected assignment under the writer lock; do not infer cryptographic
identity from a display name, contact merge or globally shared public address.
The contact tombstone remains effective for that R after rotation or erasure.

### 10.2 Binding and contact policy

The same `relationship.bound` is produced from an incoming root-address
observation or an outgoing birth selection. In each case it pins the root
local DID and exact peer resolution. Concurrent-in-flight opposite first sends
over the same two addresses reuse the same R; no initiator/responder binding
types or role arbitration are needed. Different first snapshots for one R
still conflict rather than selecting one by receive order after import.

After receipt, default application policy creates or reuses the contact
assigned to R. If R is unassigned,
use section 10.1's deterministic contact unless an explicit local selection
already chose one; tombstones still prohibit recreation. Control input alone
creates no contact or privacy response, but may bind R and process scoped ACKs. All
receipts use the same scope rules. Contact assignment, ordinary protocol
effects and section 11's privacy policy are independently recoverable work;
none supplies a missing cryptographic relationship scope.

Profile disclosures belong to R through their exact source messages under
`vault-events.md` sections 11.3–11.4. Contact profile display follows that R's
assignment; shared addresses or keys do not transfer claims between Rs.

## 11. Early private-address policy and notifications

The core does not require private addresses. Estoc's default local policy is:
when an application input arrives in a bound R whose current local address
is its birth address, prefer a fresh private successor if that address has
a committed `did.disclosed` with `as == "oob"` or `uses == "many"`, or occurs
in another relationship's local history. An already
private address needs no change. No policy requires the peer to rotate.

Under the writer lock, reuse any existing local transition. Otherwise select
one eligible committed application observation with no already selected natural,
pure-ACK or notification response, validate its exact-root
confirmation, and atomically commit a fresh successor and a normal
`relationship.localTransitioned` whose `triggerEventId` references that observation.
The allocation MAY use section 10's endpoint-specific deterministic ID under
`vault-events.md` section 12.4; otherwise it uses a fresh UUIDv7.
Route, proof and trigger are frozen by this commit. A retry reuses them.
The public/reuse predicate is a producer policy choice evaluated there, not
a fold-time test that can invalidate a committed edge. If an old input already
has a response, reuse it and wait for a new eligible trigger or an explicit
local rotation; never rewrite its response to add a notification. A
manual policy may keep using the root, rotate later, or use a normal reply
before rotation; the relationship already exists in each case.

### 11.1 Automatic response selection

A non-null local-transition trigger requires one deterministic notification
effect recoverable from that exact input, even if the process exits before
its response intent, subject to ordinary erasure and contact lifecycle. Select
an ordinary natural protocol response when it is
deterministic from the input, otherwise Empty. For Trust Ping, use
`ping-response` only when `response_requested` is not false; otherwise use
Empty for the address notification. Human-authored content may disclose the
same rotation in an ordinary send, but does not replace a required committed
trigger's idempotent automatic effect.

Use the trigger's relationship execution ID and the natural protocol tuple,
or `distributed-delivery.md` section 8.2's pure-ACK/Empty tuple. Merge eligible
requested ACK targets into this one response under that document's section
8.1. Do not create a second ACK-bearing response for the same execution. The
notification freezes `pleaseAck == [""]`; its `createdTime` is the trigger's
nullable creation time and its expiry is null. Its wire thread follows the
natural protocol, or the Empty profile. Rotation `iat` is independently sampled
once at the local edge, never copied from message creation time.

Empty, `ping-response`, Report Problem and other control input cannot trigger
another early-privacy notification. A generic pure ACK never requests an ACK.
Receipt of a notification may confirm a peer's transition and produce a
permitted ACK; it is not a recursive handoff request.

For the first section-10 fixture's R and wire ID
`019b4d12-090a-7c3b-92f7-ac2c51f50db4`, the Trust Ping notification vectors are:

```text
executionId = 148d31a6-66d0-5687-a1f1-2c2c75ac7817
handlerId   = https://didcomm.org/trust-ping/2.0
effectKind  = ping-response
ordinal     = 0
effectKey   = VXXR0fOxbJlvgykd90BsYKbbh4K85FsNhordsPbFw7Y
messageId   = 8e0d1442-50f3-57b6-a356-7939851af021
```

For Empty with the same execution:

```text
effectKey = HTh08t3qCpxpGnvXXQq7ClgPUIhSNi7d6uSkk27RAWA
messageId = 7e6a39e8-57fb-5cca-9460-edfc806a2297
```

### 11.2 Proof and ordinary message headers

All local changes use `vault-events.md` section 12.4's one JWT construction.
There is no initial-handoff proof variant. The package's sender is the current
local end, recipient the current peer end, and proof the current local edge's
exact JWT while unconfirmed. Ordinary content, Empty and Trust Ping use the
same spelling, authentication and confirmation rules.

### 11.3 Registration and submission

Persist the chosen successor/edge before recipient-registration and send work.
Verify its live mediated registration before first disclosure. Commit exact
package bytes before submission, then commit `delivery.submitted` on acceptance.
Lost notifications do not cause automatic resubmission after that boundary;
another ordinary message may carry the same unconfirmed proof.

### 11.4 Confirmation and overlap

Authenticated input in R at the exact current successor confirms it. Input at
another local historical address does not. Until confirmation, every new
package from this end uses its long form and retained proof. Afterward, new
packages omit the proof; exact prepared packages are not rewritten. Predecessor
receipt routes overlap as specified in `vault-events.md` section 12.4.
A manual rotation can solicit that input with the response-requesting ordinary
Trust Ping in `vault-events.md` section 16.7.

## 12. Peer address changes

For a carrier from B1 to any retained local address A in R:

1. authenticate the carrier and retain its exact sender resolution;
2. use `(A, B0)` from `iss=B0` to find the unique candidate R, including its
   historical local addresses; known B1 alone does not excuse proof validation;
3. verify the JWT against R's exact pinned/verified predecessor document and
   authorized authentication method, comparing predecessor spellings and method
   IDs under `vault-events.md` section 11.2; the pinned `presentedDid` need not
   be byte-identical to `iss`;
4. require `sub` to equal the carrier's exact authenticated sender spelling,
   with a valid long form on first Peer-DID disclosure, and require the carrier
   to satisfy the witness rule in `vault-events.md` section 10.5 with that
   document's section-11.2 requirements;
5. commit `relationship.peerTransitioned` for that R before ACK/effect work,
   reusing a duplicate edge and surfacing incompatible successors or evidence
   as conflict;
6. use the new peer end for further communication in R, preserving its birth
   ID, message identity and all unrelated relationships.

Missing historical documents defer verification; current network documents
cannot replace them unless their canonical raw CID is identical. A proof is
not a global DID alias. A shared public address, thread or contact name alone
cannot identify R. Unmatched/missing proof evidence never bootstraps a new R
from B1. When an authenticated committed carrier's `iss` pair has no binding,
its actual local/B1 pair is known pending membership under `vault-events.md`
section 12.1. Later proof-free input to that same pair waits before durable
receipt; it cannot silently create a replacement relationship. Recovery of the
predecessor evidence and verification of the carried edge unlock that pair.
Without that evidence it remains pending; this profile supplies no automatic
restore fallback. The pending claim is not a global block on B1 at unrelated
local addresses. Once verified, subsequent proof-free B1 input uses its saved
binding and transition references, equally at root or successor local addresses.

Changes to opposite ends commute. A crossed pair of rotations, A1-to-B0 and
B1-to-A0, finds the same R through retained histories and independently updates
its two ends. Each side must have the predecessor knowledge required by its
own local rotation; no peer rotation is a prerequisite.

## 13. Remote errors and integrity failures

The local all-valid-input path has no admission/decline response. Integrity
failures follow section 9; policy does not reject a peer merely for retaining
a public address. Remote peers may send ordinary protocol errors.

Report Problem uses its standard `pthid` correlation to the triggering
message's `thid`, or wire ID when absent, under
[DIDComm Problem Reports](https://identity.foundation/didcomm-messaging/spec/v2.1/#problem-reports).
Other protocols use their defined correlation. Validate the report in the same
R; explicit ACKs prove only receipt. A no-response error with no rotation or
ACK request is a control observation under `vault-events.md` section 14.7.
It creates no privacy reply or new contact. Its retained reason can appear
beside one uniquely correlated outbound; erasure removes that diagnostic.
It does not terminate R, confirm a local successor or reopen a submitted message ID.

## 14. Retry, replacement and address rollover

All outbound messages use bounded local retry before committed submission:

```text
minimum automatic retry interval = 30 seconds
exponential backoff cap = 21600 seconds
transport-attempt budget per wire ID per active runtime = 32
mandatory absolute stop = expires_time, when non-null
```

The sender SHOULD use these defaults or a stricter local policy. Count before
transport invocation, including unknown outcomes, with shared accounting per
message ID. Restart/restore may reset this local budget but never a committed
`delivery.submitted`. Expiry is immutable and stops new work at equality. No
durable pre-call reservation or lifetime attempt cap is implied. Unknown
outcomes reuse exact eligible packages; absent submission evidence does not
prove no transport call occurred.

A new explicit send uses a new message ID in the same R. It does not rederive R from
current keys or addresses. Permitted repacks change address/proof evidence
only along that R's verified chains while preserving intent. A submitted message ID
never reopens for missing ACK, lost confirmation, duplicate input or rotation.

A Peer DID's embedded keys/route cannot change in place. A new address with a
scoped rotation continues R; publishing a replacement discovery address does
not update existing relationships or old invitations by itself. Mediation
preference affects new route choices only. Vault-wide route migration remains
outside this per-relationship profile.

## 15. Phase-1 execution and deferred replication

Phase 1 permits exactly one active writable full vault runtime. It may run in a
local application or on a server. It uses ordinary Coordinate Mediation and
account-scoped Message Pickup; no `replica_id` appears in peer or mediator wire
messages.

`replica-mediation/1.0` and `vault-sync/1.0` are deferred. Their absence MUST
NOT block local vault operation, rendezvous, pairwise communication, export or
seed recovery. The local `replica_id` remains the event author so replication
can be added later without changing event envelopes.

Concurrent writers, automatic-rotation coordination and per-replica pickup
are not phase-1 conformance claims; accidental divergent histories still have
the specified import conflict rules.

## 16. Privacy, abuse, interoperability and security

Publicly disclosed addresses are correlatable within their audience. Fresh
pairwise allocation reduces address reuse, but the mediator may still correlate
addresses registered under one account. A new address may use another route;
neither a new DID nor a shared route proves a different human or contact.

The default allocator avoids reusing private addresses and public disclosure
avoids revealing them. Core authentication, relationship formation and rotation
do not inspect an address role. One local DID can occur in multiple R histories;
only ambiguous claims on the same address pair conflict. A scoped change never
globally links or retires all uses of a shared DID.

All otherwise valid input is received without initial age/type/lifetime policy.
Authentication, one-use invitation integrity, source rate limits and actual
storage/ingress exhaustion remain. Ordinary contact deletion and erasure remain
available. Current sender-resolution failure does not bypass authentication or
historical proof verification.

The UI MUST NOT describe a public/public or public/pairwise relationship as
incomplete merely because no rotation occurred. Rotation confirmation and ACK
receipt information are separate. An unconfirmed terminal successor still has
the explicit recovery limitation in `vault-events.md` section 12.4; submitted
notification loss is recovered only by another explicit ordinary send, not
automatic resubmission of the completed message ID.

## 17. Required conformance cases

1. Peer-DID first disclosure validates its long form, canonical short form, fixed keys and bound route without DNS.
2. An external Web DID pins exact document bytes; a later network revision cannot replace historical proof evidence.
3. No emitted message uses an Estoc rendezvous request, accept or decline type, or a wire relationship ID.
4. Public/public, public/pairwise and pairwise/pairwise address pairs all bind through the same event and receive path.
5. Run both section-10 relationship fixtures in both directions and obtain each published R, including the higher-sorting A fixture. Distinct canonical pairs differ.
6. Peer long and short spellings normalize to one birth address. No shared key, endpoint, label or resolver alias merges distinct DIDs.
7. Opposite first sends over the same address pair, before either reply is received, bind the same R and reuse contact assignment.
8. A different selected key within one pinned peer document does not change R or create a second contact.
9. Root public addresses can send ordinary content before a reply, private allocation or rotation confirmation.
10. Offline birth intent commits without DNS or a mediator. Resolution later creates the common binding before its first package.
11. An incoming binding that precedes preparation of an opposite queued birth is reused without replacing its pin. Fresh resolution selects an already authorized key or follows section 5.1's failure rule; imported incompatible binding pins conflict.
12. One shared address used with two different peers forms two Rs without exclusive-local-DID ownership conflict.
13. A0-to-A1 in R_AB leaves R_AC and public disclosure of A0 unchanged. Pairwise allocation avoids reuse as policy.
14. Birth R remains stable after either or both endpoints rotate; current-address derivation is never substituted.
15. Early privacy rotation uses the ordinary local-transition event, a fresh successor with an optionally deterministic endpoint-specific ID, and a frozen trigger.
16. A crash after successor/edge commit reuses the exact route, keys, JWT, iat and notification trigger.
17. Missing optional private allocation does not prevent binding or a normal public-address reply.
18. Normal Trust Ping selects ping-response; response_requested false is still received and may get an independent Empty rotation notification.
19. Content-first Basic Message remains its own application message without a rendezvous wrapper.
20. Empty, ping-response and Report Problem can bind and process eligible ACKs but create no contact or recursive privacy notification.
21. Generic pure ACK has no ACK request. A privacy notification and natural response share the execution's one ACK-bearing selection.
22. A notification carries the current successor's exact proof and long form; later proof-free messages use retained scoped transition evidence.
23. Input at the exact successor confirms rotation; input at a predecessor does not. Explicit ACK naming a message remains separate.
24. No second local edge is authorized before the peer knows its predecessor. A normal incoming root-address message supplies first-edge confirmation.
25. Both live recipient routes remain during rotation overlap. Shared routes/addresses survive until unrelated users no longer need them.
26. Receive a successor with proof at the original public address and at a private historical address: both locate and extend the same R.
27. Crossed A1-to-B0 and B1-to-A0 rotations update separate ends of one R and converge to A1/B1 in either fold order.
28. A forged proof, wrong sub, wrong recipient relationship, unauthorized signing key or incompatible pinned document cannot extend a chain.
29. Repeated proof reuses its transition and pinned successor document; later resolution cannot enlarge authorized keys.
30. Competing successors, cycles and an address pair claimed by distinct Rs are conflicts without automatic merge or event-order winner.
31. Missing binding/transition references defer through partial import; a pending proof cannot fall back to a new relationship birth.
32. A current peer DID using an unpinned current key is retained as a no-scope diagnostic; no new R, ACK or effect is created. A superseded sender first follows section 9.3.
33. After B0-to-B1 commits in R, a new message ID from B0 to any local address in R is terminal before message.in, with pickup ACK only. A matching committed observation message ID in R follows duplicate handling without a new response obligation. A later B1-to-B2 never invalidates retained B1 input; another R in which B0 remains current still receives normally.
34. One-use invitation is consumed by matching root-address receipt before contact/rotation work; continuation or matching pthid alone cannot consume it.
35. Same-consumer invitation reuse is idempotent; different consumers conflict. Crash, deletion and erasure never reopen it.
36. A retired DID cannot create new relationships but can receive in existing histories while its route remains eligible, regardless of disclosure policy.
37. A terminal route or mediation rejects input; temporary missing key/route/recovery prerequisites defer without pickup ACK.
38. Wrong recipient DID or method fragment, authentication-purpose kid and unknown Peer short form are terminal before application state.
39. Current sender authentication runs whenever a delivery enters or resumes authentication, including duplicates; while local wait state is retained, section 9.1's relationship-evidence wait suspends this work until a relevant evidence change. Historical scope evidence cannot bypass current key authorization on retry.
40. NXDOMAIN and no usable address-family data are definitive; one-family NODATA alone is not. SERVFAIL, timeout and TLS failure use bounded unavailability.
41. Per-delivery sender-resolution retries count before calls, schedule without redelivery, share accounting and stop at their finite budget or active-time retention bound. At a sequence's first attempt, a future known absolute deadline caps active time by its remaining interval, including after local-state reset; an advertised duration also caps active time. A past or unknown deadline supplies no absolute-deadline cap. Unknown retention still requires a finite budget.
42. Budget exhaustion pickup-ACKs terminal input without message.in. Locked-vault, local recovery and other non-resolution deferrals consume neither attempts nor active time, including when they interrupt a sequence. A wait that crosses an absolute deadline does not itself exhaust the retained sequence on resumption; its previously consumed attempts and active time remain counted. After loss of accounting, a permitted retry, or a redelivery with no retained wait state, instead starts a fresh finite sequence under section 5.1. Neither path permits terminal ACK solely because the wait crossed the deadline.
43. A successful current resolution within budget permits normal durable receipt. Imported receipts use retained evidence without fresh network requests.
44. Fresh recipient resolution occurs for each new message ID when required; repacking follows pinned/verified evidence and never silently changes same-DID keys.
45. Resolution failure before any prior pin uses neutral diagnostics, not an unsupported claim that a key was replaced.
46. Unsubmitted birth and ordinary intents both repack after rotation, preserving message ID, R, intent and automatic effect identity.
47. Committed submission stops all automatic repack/retry, including notification/ACK loss and duplicate receipt.
48. Expiry and local retry defaults remain independent of incoming message age, receipt acceptance and rotation iat.
49. Contact assignment is separate from binding. A control-only R has no contact; a selected existing contact wins local policy before automatic creation.
50. Conflicting contact assignments remain visible; display merges do not merge R, authorize rotation or change ACK scope.
51. Deleting a contact blocks new effects and cleans up late scoped input without retiring addresses still used by another relationship/disclosure.
52. A remote problem report is displayed only beside a uniquely correlated outbound while its body is available; it changes no submission or relationship state.
53. An unconfirmed successor with a terminal route cannot branch or roll back; temporary outage does not invoke this terminal limitation.
54. Phase-1 operation needs no replica-mediation or vault-sync implementation and discloses no replica ID to peers.
55. Crash after a new inbound binding commits but before message.in leaves reusable binding evidence, no invitation consumption and no pickup or ultimate ACK. Redelivery reauthenticates and references the previously returned binding eventId. One shared writer lock covers lookup through receipt; outbound preparation cannot interleave a competing binding between those commits.
56. A public root confirmed in R_AB still uses its long form in new R_BC until input confirms that exact root in R_BC. A predecessor pin whose presentedDid is short and a valid equivalent long-form iss/kid verify against the same pinned method; unrelated spellings or keys fail.
57. An unknown-iss carrier with authenticated sub=B1 commits unscoped and pickup-ACKs. Later proof-free B1-to-A0 input stays pending before receipt without a client retention cap; restart, body erasure and mediator expiry preserve that pair claim. Restoring and verifying the missing predecessor chain unlocks receipt in the original R, while an unrelated local/B1 pair is not blocked by this claim.
58. Long-form disclosure and later short-form lookup retain the same numalgo-4 document bytes and CID under vault-events.md section 11.1, across resolver implementations and import. Neither lookup spelling nor optional resolver transformations create another binding/transition pin.
59. did:web:Bob.Example and did:web:bob.example remain distinct identity strings and birth-pair inputs. A returned document id matching only after host case folding fails; URL/DNS processing cannot rewrite either retained DID.
60. Validated message/profile evidence reaches a contact only through relationship.contactAssigned. Reusing a public address or key in another R does not share names or disclosure history; changing either end within one R preserves that history and its contact tombstone.
61. A did:web delivery first authenticates but waits for relationship evidence. While that local wait state is retained, more than 32 redeliveries, reconnects or unrelated imports cause no resolver calls or pickup ACK. After a wait longer than advertised retention and past a known absolute deadline, relevant evidence changes start one fresh shared bounded resolution sequence; the waiting time cannot exhaust its local retention stop, including across a runtime restart or loss of local state. If reset lost the delivery's wait state, redelivery re-enters the receive/authentication gates with a fresh finite sequence, with that past deadline supplying no cap; successful authentication rediscovers any still-pending pair and returns to the wait. A permitted retry may obtain missing bytes through the next pickup. Evidence changes during an active sequence never replenish its budget. A transient 503 followed by valid resolution within that sequence permits normal receipt if relationship selection now succeeds. Repeated unavailable answers can exhaust that active sequence and take the terminal path. The mediator may independently expire the delivery without clearing the pair claim.
