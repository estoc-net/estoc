# The Estoc DASL object profile, version 1

Status: **draft, phase 1** — clean-break content-addressed object profile for the
version-3 Estoc vault.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14 when,
and only when, they appear in all capitals.

## 1. Scope

Estoc uses DASL content identifiers for immutable portable content. This
profile defines:

- the accepted DASL CID subset;
- raw and DRISL objects;
- whole-resource identity;
- the `ObjectStore` interface;
- explicit event retention roots;
- validation, collection and damage behavior;
- folder serialization;
- optional CAR transport; and
- the boundary around MASL, RASL and BDASL.

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

Normative DASL dependencies are:

- DASL CIDs: <https://dasl.ing/cid.html>;
- DRISL: <https://dasl.ing/drisl.html>; and
- CAR, when used: <https://dasl.ing/car.html>.

## 2. Terms

- **DASL CID** — a CID accepted by section 3.
- **Raw object** — one finite byte sequence addressed directly with the DASL
  `raw` codec.
- **DRISL object** — one complete canonical DRISL value addressed with the
  DASL DRISL codec.
- **Portable object** — either a raw object or DRISL object accepted by the
  vault's `ObjectStore`.
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
byte 1      codec             0x55 raw, or 0x71 DRISL/dag-cbor
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
- a codec other than `raw` (0x55) or `dag-cbor` (0x71);
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

### 4.2 DRISL object

For a value accepted by the DRISL data model:

```text
drislBytes(value) = canonical DRISL encoding of value

drislCid(value) = DASL-CID(
  version = 1,
  codec = DRISL (0x71),
  hash = SHA-256(drislBytes(value))
)
```

An accepted DRISL object MUST satisfy the complete DRISL profile, including:

- one finite, complete CBOR item and no trailing bytes;
- the deterministic CBOR/c encoding required by DRISL, except that DRISL's
  binary64-only rule for non-integral floats takes precedence over CBOR/c
  preferred shortest-float serialization;
- string-only map keys;
- map keys sorted by the bytewise lexicographic order of their canonical
  encodings as required by RFC 8949 section 4.2.1; for the string-only keys
  DRISL permits, this is equivalent to sorting first by UTF-8 byte length and
  then by the bytewise lexicographic order of the UTF-8 bytes;
- integers encoded in the shortest CBOR form and limited to major types 0 and
  1, so `-2^64 <= n <= 2^64 - 1`; an integral value outside that range is
  rejected and is never encoded as a float, and an implementation MUST reject
  rather than round a value it cannot represent exactly;
- a numeric value that is integral encoded as a CBOR integer regardless of its
  source-language numeric type; only a non-integral finite value is encoded as
  a binary64 float, and a binary64 item whose decoded value is integral is
  rejected as non-canonical;
- Tag 42 as the only accepted tag;
- Tag 42 values containing `0x00` followed by one valid binary DASL CID;
- no indefinite-length values;
- no simple values other than `false`, `true`, and `null`;
- floating-point values encoded only as 64-bit IEEE 754 binary64;
- rejection of NaN, positive infinity, negative infinity, and negative zero;
  and
- every other DRISL constraint.

Acceptance MUST be strict. A generic CBOR decoder successfully returning a
value is not sufficient.

A receiver MUST either:

1. validate the exact input bytes as canonical DRISL; or
2. strictly decode and canonical re-encode the value, then require the
   re-encoded bytes to equal the input byte-for-byte.

### 4.3 No cross-codec equivalence

A raw object containing DRISL bytes and the DRISL object represented by those
bytes have different codecs and therefore different CIDs. Estoc MUST NOT treat
them as interchangeable.

The codec is determined by the CID. A caller cannot ask a store to interpret a
raw CID as DRISL or a DRISL CID as arbitrary raw data.

### 4.4 Executable CID vectors

```text
raw bytes:       empty
binary CID:      01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
string CID:      bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku

raw bytes:       68656c6c6f                         # UTF-8 "hello"
binary CID:      015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
string CID:      bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq

DRISL bytes:     a0                                 # canonical empty map
binary CID:      01711220c19a797fa1fd590cd2e5b42d1cf5f246e29b91684e2f87404b81dc345c7a56a0
string CID:      bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua
```

Implementations MUST reproduce these values from the bytes. The `0x71` codec
is the `dag-cbor` multicodec restricted here to complete DRISL-conformant
bytes; this document uses “DRISL CID” as shorthand for that combination.

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

The following TypeScript is an interface-level data model. `DrislLink` is a
distinct application value, not an ordinary map that happens to contain a
`cid` or `$link` member. A language binding MAY use a branded class, tagged
union, symbol or equivalent unambiguous representation.

```ts
type Cid = string;

declare const drislLinkBrand: unique symbol;

type DrislLink = {
  readonly [drislLinkBrand]: true;
  readonly cid: Cid;
};

type DrislValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | Uint8Array
  | DrislLink
  | readonly DrislValue[]
  | ReadonlyMap<string, DrislValue>;

type ByteSource =
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

type ObjectInfo = {
  cid: Cid;
  /** Profile label; "drisl" is CID multicodec 0x71 plus strict DRISL bytes. */
  codec: "raw" | "drisl";
  size: number;
};

interface ObjectStore {
  /** Store exact bytes as one whole-resource raw DASL object. */
  putRaw(source: ByteSource): Promise<ObjectInfo>;

  /** Canonically encode and store one bounded DRISL value. */
  putDrisl(value: DrislValue): Promise<ObjectInfo>;

  /** Verify and atomically accept exact encoded bytes under an expected CID. */
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;

  /** Open exact portable object bytes as a stream. */
  open(cid: Cid): Promise<ReadableStream<Uint8Array> | null>;

  /** Read a bounded object; fail rather than exceed maxBytes. */
  read(cid: Cid, maxBytes: number): Promise<Uint8Array | null>;

  /** Strictly decode one bounded DRISL object. */
  readDrisl(cid: Cid, maxBytes: number): Promise<DrislValue | null>;

  stat(cid: Cid): Promise<ObjectInfo | null>;
  has(cid: Cid): Promise<boolean>;
  list(): AsyncIterable<Cid>;

  /** Retain the exact keep set; no implicit DASL-link traversal. */
  collect(keep: Iterable<Cid>): Promise<{
    unlinked: Cid[];
    young: Cid[];
  }>;
}
```

A language binding MUST preserve every DRISL integer exactly. The encoding
choice is based on the exact numeric value, not the source-language type: an
integral value uses CBOR major type 0 or 1, and only a non-integral finite value
uses binary64.

In a JavaScript/TypeScript binding, a `number` used as an integer MUST lie in
`-(2^53 - 1) <= n <= 2^53 - 1`. An integral `number` outside that range is
rejected and MUST be supplied as `bigint`; decoding returns `number` inside the
safe range and `bigint` outside it. A non-integral `number` MUST be finite,
exactly representable as the binary64 value supplied by the runtime, and is
encoded as binary64. Other language bindings MUST define an equivalent exact
boundary and MUST reject rather than round.

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

### 6.2 `putDrisl`

`putDrisl` MUST validate the value against the DRISL data model, encode exactly
one canonical DRISL object, compute its CID, and atomically store those exact
bytes. Successful resolution means the object is process-durable.

DRISL is finite and bounded. `putDrisl` MAY reject values over a documented
encoded-size, depth, map-entry or collection-length limit.

### 6.3 `putObject`

`putObject(cid, source)` MUST:

1. parse and canonicalize `cid` under section 3;
2. stream and hash all source bytes;
3. for a raw CID, require the SHA-256 digest to match;
4. for a DRISL CID, additionally enforce section 4.2;
5. reject trailing, truncated or malformed content; and
6. publish no accepted object until every check succeeds; and
7. resolve only after the accepted object is process-durable.

If the CID already exists with valid bytes, the operation is idempotent and
MUST NOT create a second portable object. The backend MAY use the successful
operation to renew local orphan age.

### 6.4 Read operations

`open(cid)` returns the exact encoded bytes identified by the CID. It returns
`null` when no accepted object exists. It MUST NOT return a partially written
object.

Verification is mandatory at acceptance: `putRaw`, `putDrisl`, `putObject` and
folder import. `open` MAY stream bytes of an already accepted object before the
digest is rechecked. A backend that rechecks lazily MUST fail the stream before
completion when the digest or DRISL conformance does not match. A consumer MUST
NOT treat streamed bytes as verified until the stream completes successfully.

`read(cid, maxBytes)` MUST determine or bound the size before allocating more
than `maxBytes`. Exceeding the bound is an error, not a truncated success.

`readDrisl` MUST reject a raw CID before reading and MUST revalidate DRISL
conformance after reading.

## 7. Event roots and retention

Every event has an explicit `roots` array defined by `event-store.md`.

A root means:

> keep this exact DASL object while this event contributes a live retention
> reference under the vault-event fold.

The following rules are normative:

1. Only a CID listed in `event.roots` creates a type-independent retention
   reference.
2. A CID written elsewhere in `data` is not automatically retained.
3. A Tag 42 link inside DRISL is not automatically retained.
4. The collector MUST NOT recursively follow DRISL links.
5. An event type that requires a linked object to remain available MUST list
   that linked object's CID explicitly in `roots`.
6. Unknown event types retain every exact CID in their `roots` array without
   needing a schema.
7. Collection treats `roots` as a set. Type-specific ordering in the array may
   still have semantic value outside collection.

Example: a DRISL metadata object links to two raw attachments. If all three
must remain available, the event lists all three:

```json
{
  "roots": [
    "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua",
    "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  ]
}
```

These are executable vectors for, respectively, canonical DRISL empty-map
bytes `a0`, an empty raw byte sequence, and raw UTF-8 bytes `hello`.

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

A malformed DRISL object is damaged even when a permissive decoder could read
it or its SHA-256 digest matches the CID.

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

Event envelopes remain RFC 8785 canonical JSON and are not converted to DRISL.
When Estoc stores another JSON document as a referenced object, the producing
profile MUST define its exact bytes.

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

The raw codec is intentional. Estoc MUST NOT silently transcode a JSON object
to DRISL and preserve the old CID or claim semantic equivalence.

Extensions MAY define DRISL schemas for their own structured objects. Their
schemas MUST state validation limits and which linked objects, if any, also
appear in event `roots`.

## 10. Folder representation

The canonical readable folder stores each accepted portable object as one
path:

```text
objects/<canonical-dasl-cid>
extensions/<extension-id>/objects/<canonical-dasl-cid>
```

The file contents are the exact portable object bytes:

- raw CID: the exact resource bytes;
- DRISL CID: the exact canonical DRISL encoding.

A folder backend MUST verify filename against bytes before acceptance. It MUST
reject hidden portable child chunks, DAG-PB nodes and UnixFS metadata.

A backend may store an object internally in extents, but export MUST create one
complete file or stream at the object path. The folder representation has no
portable extent directory.

## 11. CAR transport

An implementation MAY support DASL CAR as a batch import/export transport.
CAR is not the canonical `.estoc/` folder representation and is not an event
ordering format.

A CAR importer MUST:

- parse a version-1 CAR header as DRISL;
- accept only DASL CIDs;
- verify every CID/body pair before object acceptance;
- enforce local object and total-stream limits;
- reject a truncated block;
- after consuming the complete stream, require every CID in the header
  `roots` array to have appeared as a verified body block; and
- treat the CAR header `roots` as transport metadata, not as the vault's
  retention fold.

A CAR header does not prove that all objects reachable under a graph are
present, nor that every included object belongs to a stated root. The importer
must determine required vault objects from events after object verification.

CAR generation is not assumed deterministic. A CAR byte digest is not a vault
identity and two valid exports of the same object set may differ.

## 12. MASL, RASL and BDASL boundary

### 12.1 MASL

Core message bodies and attachments are not automatically wrapped in MASL.
DIDComm message metadata already records application-specific ordering,
filename, media type and attachment identity.

An extension or public-resource profile MAY use MASL as a DRISL metadata
object. Its MASL CID and every locally retained `src` object MUST be listed
explicitly in an event's `roots`.

### 12.2 RASL

RASL is not the private vault-sync protocol and does not imply authorization.
A future profile MAY use RASL for:

- intentionally public immutable resources; or
- client-side encrypted resources whose public ciphertext CID is safe to
  reveal.

Private vault history MUST NOT become publicly retrievable merely because it
has a DASL CID.

### 12.3 BDASL

BDASL and BLAKE3 identifiers are outside version 3. A future large-media
profile may add them only through an explicit vault-format change or a
strictly isolated extension contract. A core reader MUST reject them today.

## 13. Security and resource limits

Content addressing detects corruption; it does not establish authorization,
confidentiality, provenance or safety of the content.

A conforming implementation MUST bound at least:

- maximum accepted object size;
- maximum bounded `read` size;
- maximum DRISL encoded size;
- DRISL nesting depth;
- map entries;
- array entries;
- text and byte-string lengths;
- CAR total bytes and object count; and
- temporary disk or OPFS space used while verifying a stream.

A raw object can contain hostile file formats. A DRISL object can contain a
large number of links. Neither is executed or fetched automatically.

The store MUST hash the exact bytes it commits. It MUST NOT rely on a filename,
HTTP `Content-Digest`, server claim, CAR root list or sync descriptor without
local verification.

## 14. Required conformance cases

A conforming implementation MUST pass at least these cases:

1. One-shot and arbitrarily chunked streaming input produce the same raw DASL
   CID and exact output bytes.
2. Empty input produces the specified raw DASL CID and round-trips.
3. CIDv0, uppercase base32, non-canonical base32, `dag-pb`, non-SHA-256 and
   wrong digest length are rejected.
4. A raw CID with one changed payload byte is rejected without exposing a
   partial object.
5. A valid canonical DRISL object is accepted under its DRISL CID.
6. A DRISL object using an unsupported tag, non-string map key,
   indefinite-length value, prohibited simple value or trailing bytes is
   rejected.
7. A semantically decodable but non-canonical DRISL encoding is rejected.
8. A raw CID containing valid DRISL bytes remains a raw object and is not
   accepted by `readDrisl`.
9. Filesystem, SQL, IndexedDB and OPFS backends export identical bytes and CID
   for the same object.
10. Backend internal extent size does not affect CID or exported bytes.
11. A large object can be put, opened, verified and exported with bounded
    memory.
12. Event append fails before acceptance when any required root is absent.
13. A CID appearing only in event `data` creates no retention reference.
14. A DRISL Tag 42 link not listed in event `roots` is not implicitly retained
    or fetched.
15. Collection never removes an exact CID in the current held-root set.
16. A crash after object acceptance but before event append leaves only a
    grace-protected orphan.
17. A folder object whose filename does not match its bytes is reported as
    damage.
18. A CAR importer verifies every CID/body pair, rejects a header root absent
    from the complete body, and does not treat header `roots` as the vault
    retention set.
19. A private DASL object is not exposed through RASL without a separate
    explicit publication decision.
20. A core reader rejects a BDASL/BLAKE3 identifier.
21. DRISL map keys are ordered by canonical-encoding byte order; string keys
    therefore sort first by UTF-8 byte length and then by UTF-8 bytes.
22. The same exactly represented integral numeric value supplied through
    integer-typed and floating-typed language bindings produces identical CBOR
    integer bytes and the same CID; rounded or out-of-range integers are
    rejected.
23. If an accepted object is corrupted and a backend performs lazy read
    verification, `open` fails before successful stream completion and the
    consumer cannot treat earlier chunks as verified.
24. An integral value outside the DRISL integer range is rejected rather than
    encoded as a float, and an integral binary64 item on the wire is rejected
    as non-canonical.
25. A JavaScript integer `number` outside `±(2^53 - 1)` is rejected unless
    supplied as `bigint`; decode returns `bigint` outside the safe range.
26. A successful object put survives immediate process restart; a
    pre-resolution crash exposes either the whole object or no accepted object.
27. A live writer paused between object acceptance and event commit remains
    protected from collection even after orphan grace expires.
28. A stale keep snapshot cannot unlink an object after a referencing event
    commits; the sweep is excluded, revalidated or recomputed.
29. Reopen recovery reconstructs committed-event retention before clearing an
    abandoned pending-reference guard and before enabling GC.
30. A crash before event commit makes the accepted unreferenced object an
    ordinary grace-protected orphan after recovery; a crash after event commit
    but before guard cleanup keeps the object through the recovered event root.
