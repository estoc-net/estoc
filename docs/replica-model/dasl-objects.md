# The Estoc DASL object profile, version 1

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — clean-break content-addressed object profile for the
version-3 Estoc vault. Phase 1 accepts only raw objects; DRISL support is
deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14 when,
and only when, they appear in all capitals.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Implement object storage | [Accepted CIDs](#accepted-dasl-cids) → [Identity and vectors](#object-identity) → [ObjectStore](#objectstore) |
| Handle large objects and reads | [Whole-resource identity](#whole-resource-identity-and-large-objects) → [Read operations](#read-operations) |
| Retain and collect content | [Event roots](#event-roots-and-retention) → [Ordering, damage and collection](#write-ordering-damage-and-collection) |

<details>
<summary>Contents</summary>

- [1. Scope](#scope)
- [2. Terms](#terms)
- [3. Accepted DASL CIDs](#accepted-dasl-cids)
- [4. Object identity](#object-identity)
- [5. Whole-resource identity and large objects](#whole-resource-identity-and-large-objects)
- [6. ObjectStore](#objectstore)
- [7. Event roots and retention](#event-roots-and-retention)
- [8. Write ordering, damage and collection](#write-ordering-damage-and-collection)
- [9. Canonical JSON stored as raw DASL objects](#canonical-json-stored-as-raw-dasl-objects)
- [10. Folder representation](#folder-representation)
- [11. Deferred encodings and transports](#deferred-encodings-and-transports)
- [12. Security and resource limits](#security-and-resource-limits)
- [13. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="scope"></a>

## 1. Scope

Estoc uses DASL content identifiers for immutable portable content. This
profile defines:

- the accepted DASL CID subset;
- raw objects;
- whole-resource identity;
- the `ObjectStore` interface;
- explicit event retention roots;
- validation, collection and damage behavior;
- folder serialization; and
- the boundary around deferred encodings and transports.

This profile does **not** define:

- an IPFS node;
- DHT discovery;
- Bitswap;
- portable UnixFS DAG layouts or DAG-PB UnixFS metadata;
- DAG-PB;
- automatic graph traversal;
- a public retrieval service;
- remote authorization; or
- vault synchronization encryption.

[event-store.md](event-store.md) defines how events reference objects. [vault-folder.md](vault-folder.md)
defines the readable folder representation. [vault-sync.md](vault-sync.md) defines how exact
object bytes are hidden and transferred through an untrusted sync store.

The normative DASL dependency is DASL CIDs: <https://dasl.ing/cid.html>.

<a id="terms"></a>

## 2. Terms

- **DASL CID** — a CID accepted by section 3.
- **Raw object** — one finite byte sequence addressed directly with the DASL
  `raw` codec.
- **Portable object** — a raw object accepted by the vault's `ObjectStore`.
- **Root** — a DASL CID listed in an event envelope's `roots` array. A root is
  an explicit retention reference, not an instruction to traverse links.
- **Internal extent** — backend-private bytes used to store part of one
  portable object. An extent has no portable CID and never appears in an event.
- **Transport segment** — a protocol-private fragment used to stream one
  portable object. A segment has no portable CID and never appears in an event.

<a id="accepted-dasl-cids"></a>

## 3. Accepted DASL CIDs

An Estoc DASL CID MUST conform to the binary and canonical string rules in
[DASL Content IDs](https://dasl.ing/cid.html). This phase-1 profile accepts
only the `raw` codec (0x55). It rejects DRISL/`dag-cbor`, `dag-pb`, DAG-PB
UnixFS nodes and BDASL/BLAKE3 identifiers. Parsing and re-encoding MUST yield
the exact input string. Estoc uses unpadded strings and rejects trailing
binary bytes; a syntactically valid CID whose digest does not match
the supplied object bytes MUST also be rejected. Section 4.2 supplies the
executable raw-CID vectors.

`Cid` in the Estoc TypeScript interfaces means a validated canonical DASL CID
string, not an arbitrary string alias.

<a id="object-identity"></a>

## 4. Object identity

<a id="raw-object"></a>

### 4.1 Raw object

For a finite byte sequence `bytes`:

```text
rawCid(bytes) = DASL-CID(
  version = 1,
  codec = raw (0x55),
  hash = SHA-256(bytes)
)
```

The CID identifies the complete byte sequence. Content type, filename,
language, compression, encryption state and application meaning are not part
of the raw CID unless the application explicitly includes them in the bytes.
HTTP content coding, filesystem compression and transport framing MUST be
removed before hashing when they are not part of the application resource.

A zero-length byte sequence is a valid raw object.

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

Implementations MUST reproduce these values from the bytes.

<a id="whole-resource-identity-and-large-objects"></a>

## 5. Whole-resource identity and large objects

A portable Estoc object is content-addressed as one complete resource,
regardless of size.

Version 3 MUST NOT represent a large object as a portable UnixFS tree, a DAG-PB
tree or a protocol-defined list of chunk CIDs. The portable CID of a 700 MiB
attachment is the raw DASL CID of all 700 MiB bytes in order.

Backends MAY split one object into internal extents. Protocols MAY split one
object into transport segments. Such splitting MUST be invisible at the
portable layer:

- internal extents and transport segments have no event-visible CID;
- changing an extent or segment size MUST NOT change the portable CID;
- `open(cid)` MUST reconstruct the exact original byte sequence;
- export MUST reconstruct one exact object stream; and
- collection of a portable object collects all of its backend-private extents.

Implementations MUST support incremental SHA-256 while accepting or reading a
large raw object. They MUST NOT require the complete object to fit in memory.

An implementation MAY impose a local maximum object size. A protocol MAY
advertise a transfer maximum. Limits MUST be explicit and MUST NOT silently
change object identity.

<a id="objectstore"></a>

## 6. ObjectStore

```ts
type Cid = string & { readonly __cid: unique symbol };

type ByteSource =
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

type ObjectInfo = {
  cid: Cid;
  codec: "raw";
  size: number;
};

interface ObjectStore {
  /** Store exact bytes as one whole-resource raw DASL object. */
  putRaw(source: ByteSource): Promise<ObjectInfo>;

  /** Verify and atomically accept exact encoded bytes under an expected CID. */
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;

  /** Open exact portable object bytes as a stream. */
  open(cid: Cid): Promise<ReadableStream<Uint8Array> | null>;

  /** Read a bounded object; fail rather than exceed maxBytes. */
  read(cid: Cid, maxBytes: number): Promise<Uint8Array | null>;

  stat(cid: Cid): Promise<ObjectInfo | null>;
  has(cid: Cid): Promise<boolean>;
  list(): AsyncIterable<Cid>;

  /** Retain the exact keep set; no implicit content traversal. */
  collect(keep: Iterable<Cid>): Promise<{
    unlinked: Cid[];
    young: Cid[];
  }>;
}
```

`Cid` is a distinct validated API type. Its brand adds no bytes or JSON wrapper;
construction requires section 3's canonical-CID checks, while object acceptance
also verifies the digest against the bytes. It is not interchangeable with an
entity UUID, event ID, public key or arbitrary string. The TypeScript brand
illustrates the contract; other languages may use an equivalent nominal type.

A backend MAY expose language-specific stream types as long as the observable
semantics are equivalent.

This is the backend object interface. In a full vault, `putRaw` and `putObject`
are internal primitives for `Vault.commit` and validated import/restore, not
standalone application operations. `collect` is internal to the vault runtime,
which supplies the current held roots under [vault-events.md section 12.3](vault-events.md#held-roots).
[event-store.md section 10](event-store.md#vault-interface) defines the application-facing subset and the shared
writer lock.

Object acceptance uses the process-durable commit terminology in
[event-store.md section 2.1](event-store.md#commit-and-durability-terminology). If a put operation resolves, every later process
restart over the same intact store generation MUST observe the complete
accepted object. If the process terminates before resolution, the complete
object or no object may remain, but a partial object MUST NOT enter the accepted
namespace. Stable-media survival across sudden power loss is a separately
documented backend guarantee.

<a id="putraw"></a>

### 6.1 `putRaw`

`putRaw` MUST:

1. consume one finite source in order;
2. compute SHA-256 incrementally;
3. derive the canonical raw DASL CID;
4. make the complete object visible atomically; and
5. return only after the accepted object is process-durable.

A crash may leave backend-private temporary extents. They are not accepted
portable objects and MUST be cleaned or ignored on reopen.

<a id="putobject"></a>

### 6.2 `putObject`

`putObject(cid, source)` MUST:

1. require `cid` to be canonical under section 3 with codec `raw`;
2. stream and hash all source bytes;
3. require the SHA-256 digest to match;
4. publish no accepted object until the complete stream verifies; and
5. resolve only after the accepted object is process-durable.

If the CID already exists with valid bytes, the operation is idempotent and
MUST NOT create a second portable object. The backend MAY use the successful
operation to renew local orphan age.

<a id="read-operations"></a>

### 6.3 Read operations

`open(cid)` returns the exact encoded bytes identified by the CID. It returns
`null` when no accepted object exists. It MUST NOT return a partially written
object.

Verification is mandatory at acceptance: `putRaw`, `putObject` and folder
import. `open` MAY stream bytes of an already accepted object before the digest
is rechecked. A backend that rechecks lazily MUST fail the stream before
completion when the digest does not match. A consumer MUST NOT treat streamed
bytes as verified until the stream completes successfully.

`read(cid, maxBytes)` MUST determine or bound the size before allocating more
than `maxBytes`. Exceeding the bound is an error, not a truncated success.

Object streams and bounded reads use the read protection in [event-store.md section 10](event-store.md#vault-interface). Collection cannot unlink their bytes during the read. Within an
active writer runtime, a caller's stream lifetime does not hold its operation
lock; a read-only stream opened without a writer follows that section's
rule for excluding a later writer or sharing latches with it.

<a id="event-roots-and-retention"></a>

## 7. Event roots and retention

Every event has an explicit `roots` array defined by [event-store.md](event-store.md).

A root means:

> keep this exact DASL object while this event contributes a live retention
> reference under the vault-event fold.

The following rules are normative:

1. Only a CID listed in `event.roots` creates a type-independent retention
   reference.
2. A CID written elsewhere in `data` is not automatically retained.
3. The collector MUST NOT inspect object content or follow embedded links.
4. An event type that requires another object to remain available MUST list
   that object's CID explicitly in `roots`.
5. Unknown event types retain every exact CID in their `roots` array without
   needing a schema.
6. Collection treats `roots` as a set. Type-specific ordering in the array may
   still have semantic value outside collection.

For example, a stored message document naming two object-backed attachments
lists its own raw CID and both attachment CIDs in the event's `roots`. A CID
mentioned only inside the document does not retain or fetch that attachment.

<a id="write-ordering-damage-and-collection"></a>

## 8. Write ordering, damage and collection

<a id="write-before-reference"></a>

### 8.1 Write-before-reference

Locally authored events MUST use `Vault.commit`, including `commit([], drafts)`
when there are no new objects, under [event-store.md section 10](event-store.md#vault-interface). New objects
are accepted within the commit that references them; collection never runs
concurrently with that commit.

A failure or crash after object acceptance but before event commit may leave
an orphan. Reopen MUST reconstruct every committed event and the resulting
held-root set before enabling collection. A recovered committed reference keeps
its object; otherwise the accepted object follows the orphan-grace policy.

<a id="missing-and-damaged-objects"></a>

### 8.2 Missing and damaged objects

The object store reports presence, validated size/codec and damage. The
semantic layer decides whether absence means:

- globally erased by a vault event;
- missing or corrupt local data; or
- not yet fetched under an explicitly partial local view.

A file or row whose bytes do not match its CID is damaged, not an alternate
version. It MUST be excluded from normal reads and SHOULD be quarantined before
repair.

<a id="collection"></a>

### 8.3 Collection

`collect(keep)` compares exact accepted object CIDs against the exact `keep`
set. It does not traverse links. Duplicate values in `keep` have no additional
effect. Every input CID MUST already be canonical; an invalid CID fails the
operation before collection begins.

The returned `unlinked` array contains exact CIDs physically made unavailable
by this collection pass. The returned `young` array contains unkept CIDs that
were retained only because their orphan grace period had not elapsed. Both
arrays MUST contain canonical unique CIDs. Their order is not semantically
significant. An implementation SHOULD return them in binary-CID byte order for
deterministic diagnostics.

An active read latch causes collection to skip that CID under [event-store.md section 10](event-store.md#vault-interface). CIDs skipped because of read latches appear in neither output
array. Release of the latch does not itself trigger unlink.

The store MAY unlink an unkept object only after its documented orphan grace
period. Grace covers abandoned writes after failure or crash. Live operations
use the writer-lock boundaries in [event-store.md section 10](event-store.md#vault-interface).

The semantic layer computes `keep` from [vault-events.md](vault-events.md); the object store
MUST NOT inspect event types.

<a id="canonical-json-stored-as-raw-dasl-objects"></a>

## 9. Canonical JSON stored as raw DASL objects

Event envelopes remain RFC 8785 canonical JSON. When Estoc stores another JSON
document as a referenced object, the producing profile MUST define its exact
bytes.

The core vault uses raw DASL objects for:

- RFC 8785 canonical stored message documents;
- RFC 8785 canonical DID documents and resolution snapshots when a profile
  calls for canonical JSON;
- normalized DIDComm encrypted envelopes;
- attachment `data.json` converted to the profile's canonical JSON bytes; and
- any other JSON content whose defining specification selects RFC 8785.

For a DIDComm encrypted JSON envelope, normalized bytes are
`UTF8(RFC8785(parsedEnvelope))`. Parsing MUST reject duplicate members and
invalid I-JSON before canonicalization. The exact normalized bytes are stored,
hashed, retried and submitted; original insignificant whitespace or member
order is not portable state.

For such an object:

```text
bytes = UTF8(RFC8785(value))
cid   = rawCid(bytes)
```

The raw codec is intentional. Changing the encoded bytes changes the CID;
Estoc MUST NOT transcode a stored document and preserve its old CID.

<a id="folder-representation"></a>

## 10. Folder representation

The canonical readable folder stores each accepted portable object as one
path:

```text
objects/<canonical-dasl-cid>
```

The file contents are the exact complete resource bytes identified by the raw
CID.

A folder backend MUST verify filename against bytes before acceptance. It MUST
reject hidden portable child chunks, DAG-PB nodes and UnixFS metadata.

A backend may store an object internally in extents, but export MUST create one
complete file or stream at the object path. The folder representation has no
portable extent directory.

<a id="deferred-encodings-and-transports"></a>

## 11. Deferred encodings and transports

DRISL objects, typed CBOR APIs, MASL metadata and CAR transport are deferred.
They are not version-3 core requirements. A future profile must define their
encoding, validation and transport rules before use. Adding a portable codec
requires an explicit vault-format version change; version-3 readers MUST reject
non-raw CIDs even when they recognize the encoding.

Raw bytes remain opaque regardless of the format they happen to encode. Their
acceptance does not enable a structured decoder, content traversal or another
CID codec.

RASL publication is outside this private vault profile. Private vault history
MUST NOT become publicly retrievable merely because it has a DASL CID.
BDASL/BLAKE3 identifiers remain outside version 3.

<a id="security-and-resource-limits"></a>

## 12. Security and resource limits

Content addressing detects corruption; it does not establish authorization,
confidentiality, provenance or safety of the content.

A conforming implementation MUST bound at least:

- maximum accepted object size;
- maximum bounded `read` size; and
- temporary disk or OPFS space used while verifying a stream.

A raw object can contain hostile file formats or embedded links. The object
store neither executes content nor fetches its links.

The store MUST hash the exact bytes it commits. It MUST NOT rely on a filename,
HTTP `Content-Digest`, server claim or sync descriptor without local
verification.

<a id="required-conformance-cases"></a>

## 13. Required conformance cases

A conforming implementation MUST pass at least these cases:


<a id="object-identity-verification-and-streaming-do-1-do-7"></a>

### Object identity, verification and streaming (DO-1–DO-7)

1. <a id="do-1"></a> One-shot and arbitrarily chunked streaming input produce the same raw DASL
   CID and exact output bytes.
2. <a id="do-2"></a> Empty input produces the specified raw DASL CID and round-trips.
3. <a id="do-3"></a> CIDv0, uppercase base32, non-canonical base32, DRISL/`dag-cbor`,
   `dag-pb`, non-SHA-256 and wrong digest length are rejected.
4. <a id="do-4"></a> A raw CID with one changed payload byte is rejected without exposing a
   partial object.
5. <a id="do-5"></a> Filesystem, SQL, IndexedDB and OPFS backends export identical bytes and CID
   for the same object.
6. <a id="do-6"></a> Backend internal extent size does not affect CID or exported bytes.
7. <a id="do-7"></a> A large object can be put, opened, verified and exported with bounded
   memory.

<a id="commit-roots-collection-and-damage-do-8-do-16"></a>

### Commit roots, collection and damage (DO-8–DO-16)

8. <a id="do-8"></a> A commit appends no events when a supplied object fails verification or any
   required root, including a reused root, is absent.
9. <a id="do-9"></a> A CID appearing only in event `data` creates no retention reference.
10. <a id="do-10"></a> A CID embedded in object content but absent from event `roots` is not
    implicitly retained or fetched.
11. <a id="do-11"></a> Collection never removes an exact CID in the current held-root set.
12. <a id="do-12"></a> A crash after object acceptance but before event append leaves only a
    grace-protected orphan.
13. <a id="do-13"></a> A folder object whose filename does not match its bytes is reported as
    damage.
14. <a id="do-14"></a> A private DASL object is not exposed through RASL without a separate
    explicit publication decision.
15. <a id="do-15"></a> A core reader rejects a BDASL/BLAKE3 identifier.
16. <a id="do-16"></a> If an accepted object is corrupted and a backend performs lazy read
    verification, `open` fails before successful stream completion and the
    consumer cannot treat earlier chunks as verified.

<a id="durability-and-collection-recovery-do-17-do-21"></a>

### Durability and collection recovery (DO-17–DO-21)

17. <a id="do-17"></a> A successful object put survives immediate process restart; a
    pre-resolution crash exposes either the whole object or no accepted object.
18. <a id="do-18"></a> Collection waits while a commit pauses between object acceptance and event
    append, even after orphan grace expires; on success the event retains the
    object.
19. <a id="do-19"></a> Collection computes its held-root set after acquiring the writer lock and
    holds it through unlink; a reference commit completes before that fold or
    starts after the collection pass.
20. <a id="do-20"></a> Reopen recovery reconstructs committed-event retention before enabling GC.
21. <a id="do-21"></a> A crash before event commit makes the accepted unreferenced object an
    ordinary grace-protected orphan after recovery; a crash after event commit
    keeps the object through the recovered event root.
