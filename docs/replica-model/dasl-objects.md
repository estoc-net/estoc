# The Estoc DASL object profile, version 1

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1**. The version-3 vault accepts only whole-resource raw
DASL objects. Capitalized requirement words have their BCP 14 meanings.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Sections |
| --- | --- |
| Implement identity | [Accepted CIDs](#accepted-dasl-cids), [vectors](#object-identity) |
| Store or read bytes | [Large objects](#whole-resource-identity-and-large-objects), [ObjectStore](#objectstore), [SQLite](vault-sqlite.md#objects-and-streams) |
| Retain or delete | [Event roots](#event-roots-and-retention), [collection](#collection) |

<!-- reading-guide:end -->

<a id="scope"></a>

## 1. Scope

This profile owns CID identity, the object API, verification and retention
semantics. [event-store.md](event-store.md) owns atomic vault commits;
[vault-sqlite.md](vault-sqlite.md) owns persistence and maintenance. Deferred
[vault-sync.md](vault-sync.md) encrypts and transfers these exact bytes.
This is not an IPFS node, discovery service, automatic graph traversal or public
retrieval protocol. The normative CID dependency is
[DASL Content IDs](https://dasl.ing/cid.html).

<a id="terms"></a>

## 2. Terms

A **raw object** is one finite byte sequence addressed by its raw DASL CID.
An accepted raw object is a **portable object**. A **root** is an explicit CID
in an event's roots array, not an instruction to traverse content. Internal
storage extents and transport segments are private fragments without their own
portable CID; neither may appear as a separate event reference.

<a id="accepted-dasl-cids"></a>

## 3. Accepted DASL CIDs

Accept canonical CIDv1 with codec `raw` (0x55), SHA-256 and its 32-byte digest,
encoded as lowercase base32 without padding. Parsing and re-encoding MUST yield
the exact input; reject trailing binary bytes. Reject CIDv0, noncanonical base32,
DRISL/`dag-cbor`, `dag-pb`/UnixFS and BDASL/BLAKE3. A valid identifier still does
not accept bytes whose digest differs. `Cid` means this validated nominal type,
not an arbitrary string.

<a id="object-identity"></a>

## 4. Object identity

<a id="raw-object"></a>

### 4.1 Raw object

```text
rawCid(bytes) = DASL-CID(version = 1, codec = raw, hash = SHA-256(bytes))
```

The CID identifies the complete bytes. Filename, media type and application
meaning do not affect it unless encoded in those bytes. Remove transport framing
or content coding before hashing when it is not part of the application resource.
Empty bytes are a valid object. Never transcode bytes while keeping their old CID.

<a id="executable-cid-vectors"></a>

### 4.2 Executable CID vectors

```text
raw bytes:       empty
binary CID:      01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
string CID:      bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku

raw bytes:       68656c6c6f                         # UTF-8 "hello"
binary CID:      015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
string CID:      bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq
```

Implementations MUST reproduce both vectors.

<a id="whole-resource-identity-and-large-objects"></a>

## 5. Whole-resource identity and large objects

An object has one whole-resource CID regardless of size. It is never replaced
by a portable tree or list of chunk CIDs. Storage may use internal chunks and
protocols may use transport segments, but changing those boundaries cannot
change the object CID or reconstructed bytes. Collection removes the object's
stored chunks too.

Accept and verify large objects using incremental SHA-256 and bounded buffers,
not a required whole-object allocation. Object and temporary-space limits must
be explicit; reject excess input rather than truncating it or changing identity.

<a id="objectstore"></a>

## 6. ObjectStore

```ts
type Cid = string & { readonly __cid: unique symbol };
type ByteSource =
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;
type ObjectInfo = { cid: Cid; codec: "raw"; size: number };

interface ObjectStore {
  putRaw(source: ByteSource): Promise<ObjectInfo>;
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;
  open(cid: Cid): Promise<ReadableStream<Uint8Array> | null>;
  read(cid: Cid, maxBytes: number): Promise<Uint8Array | null>;
  stat(cid: Cid): Promise<ObjectInfo | null>;
  has(cid: Cid): Promise<boolean>;
  list(): AsyncIterable<Cid>;
  collect(keep: Iterable<Cid>): Promise<{ removed: Cid[] }>;
}
```

A brand adds no bytes; construction checks CID syntax and acceptance additionally
checks bytes. `size` is an exact nonnegative safe integer in this API. Equivalent
language-specific stream types are permitted.

This is an internal backend interface. Full-vault callers have no standalone
put or collect: [ES §10](event-store.md#vault-interface) exposes reads and commit.
Preparation is private. Accepting a full commit's objects and events uses one
transaction, not independently committed primitive calls. Standalone primitive
tests obey [ES §2.1](event-store.md#commit-and-durability-terminology): success is
process-durable; a pre-resolution crash leaves the whole object or none, never
partially accepted bytes.

<a id="putraw"></a>

### 6.1 `putRaw`

Consume one finite source in order, hash incrementally, derive its raw CID,
accept the complete bytes atomically and return only after durable acceptance.
An existing CID follows [section 6.2](#putobject)'s idempotence and repair rules.
Temporary partial bytes are not accepted objects and may be discarded on recovery.

<a id="putobject"></a>

### 6.2 `putObject`

Validate the expected raw CID, consume and hash all source bytes, require a
matching digest, and publish only complete verified bytes at the same durable
boundary. A sound existing CID is idempotent; it does not create a second object.
No acceptance-age renewal is part of this interface.

For a known-damaged existing CID, `putObject` MUST replace its complete bytes
and metadata with the verified supplied value in one transaction, after
quiescing readers under [SQ §6.2](vault-sqlite.md#reads-damage-and-collection).
Clear known damage only after successful publication; invalid replacement bytes
or rollback leave the existing bytes and damage state unchanged. Full commits
and import use this same replacement rule within their enclosing acceptance
transaction.

<a id="read-operations"></a>

### 6.3 Read operations

`open` returns complete accepted bytes, or null for absence. `stat` returns their
validated metadata or null; `has` reports accepted presence; `list` enumerates
accepted CIDs without duplicates, not temporary preparation. Presence and metadata
results do not certify content integrity or guarantee that a later read succeeds.

Known damage means damage known to the current open store session. It need not
be persisted across close/reopen; a later session may discover it again.
An accepted object is **sound** for reuse when it is not known damaged in that
session; this does not certify its current content integrity.
Known damage to a stored object MUST make `has`, `stat`, `open` and `read` fail
with an explicit damage error; `false` and `null` indicate absence only. `list`
MUST fail when it encounters a known damaged object, without yielding that CID
or silently omitting it from a successful result. Verified repair restores
normal results.

Bytes supplied for acceptance, import or restore MUST be verified. Reusing sound
accepted bytes does not require rehashing them. A read may stream before
rehashing finishes, but a mismatch MUST fail before successful completion.
Consumers cannot treat earlier chunks as verified until that completion.
`read(maxBytes)` bounds size before allocating and errors rather than truncating
when the bound is exceeded.

Reads follow [SQ §6.2](vault-sqlite.md#reads-damage-and-collection): they may wait,
fail or be explicitly cancelled to allow writes or maintenance, but cannot
successfully return truncated or mixed bytes. This API does not require latches,
indefinitely paused streams, concurrent writers or seamless online repair.

<a id="event-roots-and-retention"></a>

## 7. Event roots and retention

An event root means keep that exact object while the event contributes a live
reference under [vault-events.md](vault-events.md). Only explicit roots create
retention edges. CIDs elsewhere in data or object content do not retain or fetch
anything. Unknown valid event types retain every listed root. Collection treats
roots as a set and never follows embedded links; type-specific array ordering
may still matter to the defining payload.

For example, retaining a message document and two object-backed attachments
requires listing all three CIDs in event roots, even if the document names the
attachments internally.

<a id="write-ordering-damage-and-collection"></a>

## 8. Write ordering, damage and collection

<a id="write-before-reference"></a>

### 8.1 Objects and references

All local events use `Vault.commit`, including events with no new objects.
The commit validates roots and accepts new objects together with their events.
Supplied objects must be referenced by its drafts. Failed preparation leaves no
accepted orphan. Collection is serialized against that commit and reconstructs
retention from recovered committed events before running.

<a id="missing-and-damaged-objects"></a>

### 8.2 Missing and damaged objects

The semantic layer distinguishes policy erasure from unavailable/corrupt bytes
and explicitly partial sync views. An object whose bytes do not match its CID
is damaged, not another valid version. Report damage and fail affected reads
under [section 6.3](#read-operations) while the damaged object remains stored.
Verified repair restores normal results. SQLite maintenance procedures, not an
additional portable quarantine or version format, are defined in SQ.

<a id="collection"></a>

### 8.3 Collection

`collect(keep)` compares accepted CIDs to the exact keep set. Validate all input
CIDs before deletion; duplicates in keep have no extra effect. The vault, not
application callers, supplies held roots under the operation lock and holds it
through deletion. The object store does not interpret event types.

Collection enumerates accepted object records, including damaged ones, without
applying the public `list` failure rule. Known object damage alone MUST NOT fail
the pass: retain known-damaged held objects without clearing their damage state;
delete damaged unheld objects normally. Storage, enumeration and transaction
failures still surface as errors.

`removed` contains unique canonical CIDs actually deleted by the pass, including
damaged objects; order is not significant. After deletion, read and presence
operations report absence even if historical damage diagnostics remain.
There is no `young` result or orphan-age guarantee.
Unheld objects may be deleted once reads are quiesced under SQ's maintenance
rules. Removal is atomic within SQLite and does not promise immediate file
shrinkage or forensic erasure.

<a id="canonical-json-stored-as-raw-dasl-objects"></a>

## 9. Canonical JSON stored as raw DASL objects

The producing profile defines an object's exact bytes. For core JSON objects
whose profile selects RFC 8785 (stored messages, DID/resolution snapshots,
normalized encrypted envelopes and normalized attachment JSON):

```text
bytes = UTF8(RFC8785(value))
cid   = rawCid(bytes)
```

Reject duplicate members and invalid I-JSON before canonicalization. Normalized
DIDComm envelope bytes are exactly the bytes stored, hashed, retried and
submitted; original whitespace/member order is not portable state. Raw remains
the codec. Changing encoding changes identity.

<a id="sqlite-representation"></a>

## 10. SQLite representation

[SQ §§3 and 6](vault-sqlite.md#common-schema) define CID-keyed objects and ordered
BLOB chunks in the same database as events and the wrapper. Portable snapshots
contain exactly held objects, with no local control or temporary data. Chunk
numbers are storage offsets, not separate content identities. This section adds
no physical-version, read-latch or publication protocol.

<a id="deferred-encodings-and-transports"></a>

## 11. Deferred encodings and transports

DRISL, typed CBOR, MASL and CAR are deferred, not core requirements. New portable
codecs require a vault-format version change; recognizing an encoding does not
authorize accepting it. Raw bytes remain opaque and do not enable traversal.
RASL publication is separate: private content cannot become public merely from
having a CID. BDASL/BLAKE3 stays outside version 3.

<a id="security-and-resource-limits"></a>

## 12. Security and resource limits

Content addressing checks integrity, not authorization, confidentiality,
provenance or safety. Do not execute raw content or fetch its embedded links.
Hash exact accepted bytes locally, rather than trusting a CID column, server
claim, HTTP digest or sync descriptor. Bound object/read sizes and temporary
space and report exceeded limits explicitly.

<a id="required-conformance-cases"></a>

## 13. Required conformance cases

<a id="object-identity-verification-and-streaming-do-1-do-7"></a>

### Identity, verification and streaming (DO-1–DO-7)

1. <a id="do-1"></a> One-shot and arbitrarily chunked input produce the same CID/bytes.
2. <a id="do-2"></a> Empty input reproduces the vector and round-trips.
3. <a id="do-3"></a> Noncanonical CIDs and every unsupported codec/hash are rejected.
4. <a id="do-4"></a> A changed payload byte fails acceptance without exposing partial data.
5. <a id="do-5"></a> Native/browser SQLite and memory semantic references agree on identity/bytes.
6. <a id="do-6"></a> Internal extent boundaries do not change CID or output.
7. <a id="do-7"></a> Large-object acceptance, reads and export use bounded memory.

<a id="commit-roots-collection-and-damage-do-8-do-16"></a>

### Roots, collection and damage (DO-8–DO-16)

8. <a id="do-8"></a> Bad supplied bytes or missing reused roots abort the whole commit.
9. <a id="do-9"></a> A CID only in event data creates no retention edge.
10. <a id="do-10"></a> A CID only inside object bytes creates no edge or fetch.
11. <a id="do-11"></a> Collection preserves every held root, including known damaged
    objects, whose reads and presence checks still fail after collection. Damaged
    unheld objects are deleted and included in `removed`; neither form of object
    damage alone fails the pass. Deleted CIDs subsequently report absence, even
    if damage diagnostics remain.
12. <a id="do-12"></a> Commit interruption accepts all new objects/events or none.
13. <a id="do-13"></a> Broken chunks, lengths or hashes are reported as damage.
    Known damage makes `has`, `stat`, `open` and `read` fail explicitly; `list`
    fails instead of yielding or silently omitting the damaged CID. Verified
    replacement under [section 6.2](#putobject) restores normal read, presence and
    listing results. Invalid replacement bytes or rollback leave the old bytes
    and known damage unchanged.
14. <a id="do-14"></a> Private objects are never implicitly published through RASL.
15. <a id="do-15"></a> BDASL/BLAKE3 identifiers are rejected.
16. <a id="do-16"></a> A failed lazy hash fails the stream before successful completion.

<a id="durability-and-collection-recovery-do-17-do-21"></a>

### Durability and collection (DO-17–DO-21)

17. <a id="do-17"></a> Successful primitive acceptance survives restart; partial bytes never accept.
18. <a id="do-18"></a> Collection cannot overlap a full commit's root checks and publication.
19. <a id="do-19"></a> GC computes roots after taking the operation lock and holds it through deletion.
20. <a id="do-20"></a> Reopen recovers committed retention before GC.
21. <a id="do-21"></a> Discarding preparation cannot remove committed data; unheld bytes need no age clock.
