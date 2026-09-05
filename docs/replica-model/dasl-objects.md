# The Estoc DASL object profile, version 1

Status: **draft, phase 1** — clean-break content-addressed object profile for the
version-3 Estoc vault. Phase 1 accepts only raw objects; DRISL support is
deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14 when,
and only when, they appear in all capitals.

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

`event-store.md` defines how events reference objects. `vault-folder.md`
defines the readable folder representation. `vault-sync.md` defines how exact
object bytes are hidden and transferred through an untrusted sync store.

The normative DASL dependency is DASL CIDs: <https://dasl.ing/cid.html>.

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

## 3. Accepted DASL CIDs

An Estoc DASL CID MUST be a CIDv1 in the canonical string representation of exactly 36
binary bytes with this structure:

```text
byte 0      CID version       0x01
byte 1      codec             0x55 raw
byte 2      multihash code    0x12 SHA-256
byte 3      digest length     0x20
bytes 4-35  digest            32 bytes
```

The string form MUST:

- begin with lowercase `b`;
- encode the 36 binary bytes with lowercase RFC 4648 base32;
- contain no padding;
- use the shortest canonical representation; and
- round-trip to the same exact string after parse and re-encode.

A conforming implementation MUST reject:

- CIDv0;
- any CID version other than 1;
- uppercase or mixed-case base32;
- base58 or another multibase;
- non-canonical base32;
- trailing bytes;
- a codec other than `raw` (0x55), including DRISL/`dag-cbor` (0x71);
- a hash other than SHA-256;
- a digest length other than 32 bytes;
- `dag-pb`;
- DAG-PB UnixFS nodes;
- BDASL/BLAKE3 identifiers; and
- a syntactically valid CID whose digest does not match supplied object bytes.

`Cid` in the Estoc TypeScript interfaces means a validated canonical DASL CID
string, not an arbitrary string alias.

## 4. Object identity

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

## 6. ObjectStore

```ts
type Cid = string;

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

A backend MAY expose language-specific stream types as long as the observable
semantics are equivalent.

Object acceptance uses the process-durable commit terminology in
`event-store.md` section 2.1. If a put operation resolves, every later process
restart over the same intact store generation MUST observe the complete
accepted object. If the process terminates before resolution, the complete
object or no object may remain, but a partial object MUST NOT enter the accepted
namespace. Stable-media survival across sudden power loss is a separately
documented backend guarantee.

### 6.1 `putRaw`

`putRaw` MUST:

1. consume one finite source in order;
2. compute SHA-256 incrementally;
3. derive the canonical raw DASL CID;
4. make the complete object visible atomically; and
5. return only after the accepted object is process-durable.

A crash may leave backend-private temporary extents. They are not accepted
portable objects and MUST be cleaned or ignored on reopen.

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

## 7. Event roots and retention

Every event has an explicit `roots` array defined by `event-store.md`.

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

## 8. Write ordering, damage and collection

### 8.1 Write-before-reference

A producer MUST process-durably accept every object in a new event's `roots`
before it appends the event. From acceptance until the referencing event
commits or aborts, a pending-reference guard MUST protect the object from
collection. A transactional backend MAY commit objects and the event in one
transaction whose externally visible result obeys the same ordering.

A pending-reference guard belongs to the writer or transaction generation that
created it. It MUST NOT remain semantically live after that owning runtime has
terminated. A backend MAY persist a temporary pin for crash safety, but reopen
recovery MUST classify pins from the previous runtime as abandoned only after
it has reconstructed every committed event and the resulting held-root set.
Collection MUST remain disabled until that recovery step is complete.

Dropping an abandoned guard does not by itself classify its object as an
orphan. If a recovered committed event retains the object, it remains held. If
no committed event retains it, the object is an ordinary unreferenced accepted
object and becomes collectable only under the backend's orphan-grace policy.
Thus a crash before event commit leaves an orphan after recovery, while a crash
after event commit but before guard cleanup leaves a normally retained object.

A crash after object acceptance but before event append may leave an orphan.
A successful event append MUST NOT depend on an object that was never
accepted.

### 8.2 Missing and damaged objects

The object store reports presence, validated size/codec and damage. The
semantic layer decides whether absence means:

- globally erased by a vault event;
- missing or corrupt local data; or
- not yet fetched under an explicitly partial local view.

A file or row whose bytes do not match its CID is damaged, not an alternate
version. It MUST be excluded from normal reads and SHOULD be quarantined before
repair.

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

The store MAY unlink an unkept object only after its documented orphan grace
period. Grace protects abandoned crash residue; it does not protect a live
writer that pauses between object acceptance and event commit.

The mandatory local-vault invariant is:

> Collection does not delete an object retained by any committed event and does
> not delete an object that an in-flight operation may still reference.

From object acceptance until the referencing event commits or aborts, the
producer MUST hold a temporary pin, vault-level exclusion, transaction or
another pending-reference guard. From the held-root snapshot through physical
unlink, collection MUST either exclude event commits and pending-reference
changes or atomically revalidate both the committed event frontier and all
pending guards immediately before unlink. A changed frontier or guard set makes
the stale sweep ineligible and requires recomputation or skipping the object.

Collection is also serialized with acceptance and reads. The semantic layer
computes `keep` from `vault-events.md`; the object store MUST NOT inspect event
types.

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

## 13. Required conformance cases

A conforming implementation MUST pass at least these cases:

1. One-shot and arbitrarily chunked streaming input produce the same raw DASL
   CID and exact output bytes.
2. Empty input produces the specified raw DASL CID and round-trips.
3. CIDv0, uppercase base32, non-canonical base32, DRISL/`dag-cbor`,
   `dag-pb`, non-SHA-256 and wrong digest length are rejected.
4. A raw CID with one changed payload byte is rejected without exposing a
   partial object.
5. Filesystem, SQL, IndexedDB and OPFS backends export identical bytes and CID
   for the same object.
6. Backend internal extent size does not affect CID or exported bytes.
7. A large object can be put, opened, verified and exported with bounded
   memory.
8. Event append fails before acceptance when any required root is absent.
9. A CID appearing only in event `data` creates no retention reference.
10. A CID embedded in object content but absent from event `roots` is not
    implicitly retained or fetched.
11. Collection never removes an exact CID in the current held-root set.
12. A crash after object acceptance but before event append leaves only a
    grace-protected orphan.
13. A folder object whose filename does not match its bytes is reported as
    damage.
14. A private DASL object is not exposed through RASL without a separate
    explicit publication decision.
15. A core reader rejects a BDASL/BLAKE3 identifier.
16. If an accepted object is corrupted and a backend performs lazy read
    verification, `open` fails before successful stream completion and the
    consumer cannot treat earlier chunks as verified.
17. A successful object put survives immediate process restart; a
    pre-resolution crash exposes either the whole object or no accepted object.
18. A live writer paused between object acceptance and event commit remains
    protected from collection even after orphan grace expires.
19. A stale keep snapshot cannot unlink an object after a referencing event
    commits; the sweep is excluded, revalidated or recomputed.
20. Reopen recovery reconstructs committed-event retention before clearing an
    abandoned pending-reference guard and before enabling GC.
21. A crash before event commit makes the accepted unreferenced object an
    ordinary grace-protected orphan after recovery; a crash after event commit
    but before guard cleanup keeps the object through the recovered event root.
