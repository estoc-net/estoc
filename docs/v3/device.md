# The device — draft

Status: **draft**, 2026-09-02; not implemented. Version 1 of the
device, which goes with version 3 of the folder (`vault-folder.md`
§10).

The fourth document, and the first that is not about the vault. The
three before it define a version-3 vault: an event set
(`event-store.md`), its folder (`vault-folder.md`), its events
(`vault-events.md`). This one defines what opens a vault: a
**device** — the directory that holds which author a copy writes as,
the keys that author can use, and what that copy keeps for itself and
shows nobody. None of it is in the vault. A vault holds no secret and
no local state, so its whole folder is a snapshot and an export has no
exceptions; everything that would have been an exception is here. The
vault does not know a device directory exists; a device points at a
vault.

## 1. What a device is

A device is what the three vault documents already call one — an
`author` (`event-store.md` §3), the thing `self` names in every fold
(`vault-events.md` §1) — given a place on disk. It is not a machine: a
machine may hold several, one per identity it opens, and a device that
is copied to another machine is not one device in two places but a
fault (§7). It is the pair (agent, vault) as it rests: the agent is the
program that runs, and this directory is everything the agent needs
beyond the vault to be device `dev` of that vault.

Three things, and a pointer:

- **Which author it is** — `dev` and `instance` (§3). Minted when the
  device is born, never changed, never copied.
- **Which keys it holds** — its keystore (§4): a seed of its own,
  sealed under a passphrase, and any key that was not derived from it.
  Every private key of the identity is in some device's keystore and in
  no other place; the vault's events record names, public keys and
  which device minted each, never a secret.
- **What it keeps for itself** — local state (§5): options, cache,
  trace, per owner, the three kinds `event-store.md` §7 defines.
- **The vault** — a path (§3). One device, one vault; a vault does not
  know its devices except as authors in its logs.

**What a backup is.** A backup is the record — every event, every
blob, every file — and the keys stay with the devices. Carrying the
folder to a new machine and opening it there is a **new device
joining** (§7), which the identity's other devices and its contacts
learn of by the events and protocol of `devices.md`; "all devices
lost" is answered by a pre-commitment kept cold, not by the zip. That
is the reason for the split: a seed that never leaves a device cannot
be lost with a backup, leaked by a sync, or shared by two copies that
both went on writing.

## 2. Layout

```
<device>/
  device.json              singleton — which author, which instance, which vault; §3
  keystore.json            @estoc/keystore v4 — the keys this device holds; §4
  agent/                   the agent's local state; §5
    options.json
    cache/
    trace/<stream>/<seg>.jsonl
  extensions/<ext>/        an extension's local state, mirroring the vault's extensions/<ext>/; §5
    options.json
    cache/
    trace/<seg>.jsonl
  <app>/                   an application's own local state, by its name, beside the agent's; §5
  damaged/                 what the vault store moved aside (vault-folder.md §7); the store's, delete at will
```

Paths as `vault-folder.md` §1: `/`-separated, relative to the device
root, no `.` or `..`. JSON is pretty-printed with a trailing newline;
JSONL is compact, one record per line.

Where the root is, is the host's:

- **Browser.** The origin's OPFS holds two roots side by side:
  `.estoc/` is the vault, `device/` is this. The unlocked seed cached
  in IndexedDB (§4.4) is the device's too, kept out of OPFS only
  because a non-extractable `CryptoKey` cannot be a file.
- **Daemon and CLI.** The vault is `<folder>/.estoc/`, wherever the
  person keeps the folder — the git model, the person's files around
  the machinery. The device is under the platform's state directory
  (`$XDG_STATE_HOME/estoc/devices/<dev>/` on Linux, the equivalent
  elsewhere), never inside the folder: the folder is what the person
  carries, and the device is what must not travel with it. A daemon's
  pid file and access token are the agent's local state (§5) and live
  here, not in the vault.
- **One machine, two devices, one vault** is legal: each writes its own
  `devices/<dev>/` in the vault, blobs are content-addressed and
  shared, and the lock that serialises writers is per device (§6), not
  per vault. Two *processes* of one device is what the lock prevents.

The directory is never in a snapshot, never exported, never merged,
never read by another device; nothing in it is a file in the
`FileStore` sense (`event-store.md` §6). It is not a vault and does not
look like one: no `config.json`, no `devices/`, no `blobs/`.

## 3. `device.json`

```jsonc
{
  "version": 1,
  "dev": "k7q3ma",                // the author this device writes as
  "instance": "01991c2e-…",       // what this device's change tokens name
  "vault": "/home/alice/Estoc"    // the vault's root, as the host resolves it; in the browser, the OPFS root
}
```

Written once, when the device is born (§7), and never rewritten: `dev`
is fixed for the device's life, and so is `instance`. `vault` is a
pointer the host understands — an absolute path on disk; in the
browser the field is present and names the origin's OPFS root, since
there is nowhere else the vault could be. Pointing runs one way only:
nothing in the vault names a device directory, and a vault opened by a
device it has never met simply gains an author (§6).

- **`dev`** is the device id of `event-store.md` §3 — six characters of
  lowercase base32, minted here. It is what `devices/<dev>/` in the
  vault is named for, and what every event this device appends carries
  as `author`. Not secret.
- **`instance`** names this device to the change tokens it issues
  (`event-store.md` §4.4, `vault-folder.md` §8.4), so that a fold cache
  (§5) folded under another device is rejected rather than applied. A
  device internal; nothing outside the device reads it.
- **Missing** means the device is not born yet; §7 says what happens.
- **Copied** — two directories with one `dev` — is two writers sharing
  an author, which the vault detects as a forked self
  (`event-store.md` §4.2) the moment either sees the other's events,
  and which no field here prevents: a device directory is the one
  thing that must never be duplicated.

## 4. `keystore.json` — version 4

The device's keys: every private key this device can use, and for each
where its secret is. `@estoc/keystore` version 4; the document is the
package's, and the package's rule stands: the API yields signers,
never private key bytes, except through the one escape hatch (§4.3).

```jsonc
{
  "version": 4,
  "seedJwe": "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIi…",
  "keys": [
    { "name": "anchor",    "did": "did:key:z6Mk…", "createdAt": "2026-09-02T…", "source": "seed" },
    { "name": "did/0198…", "did": "did:key:z6Mk…", "createdAt": "2026-09-02T…", "source": "seed" },
    { "name": "did/0199…", "did": "did:key:z6Mk…", "createdAt": "2026-09-02T…", "source": "stored",
      "jwe": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0…" }
  ]
}
```

### 4.1 Sources

Each entry says where its secret is. Two sources in this version; a
third is named so that its place is kept (§9):

| `source` | the secret | recovered from the name alone |
|---|---|---|
| `seed` | derived from this device's seed; the name is the path | yes |
| `stored` | generated at random; the private JWK is in the entry, sealed (§4.2) | no — the entry *is* the key |
| `external` (not in this version) | held elsewhere — a hardware wallet, an OS keychain, a non-extractable WebCrypto key; the entry says where | the holder's business |

The vault records the same thing about every key whatever its source:
a name, a public DID, and which device minted it — the `author` of its
`did.minted` (`vault-events.md` §2). Where the private half is, is the
minting device's keystore's business alone; the log does not say and
no fold asks. What the fold does say (`vault-events.md` §7.3) is which
keys *this* device may use: those whose `did.minted` this device
authored — and every such key is in this keystore by construction,
since the device wrote the event as it minted the key.

- **`seed`**: HKDF-SHA256 over the seed, salt `estoc-keystore`, info
  `estoc/v3/<ed25519|x25519>/<name>`. The label `estoc/v3` names the
  derivation scheme and does not move with the document version — a
  version-3 document read as version 4 (§4.5) derives the same keys.
  The name is the path *on this device*: the same name under another
  device's seed is a different key, which is why a name is minted with
  a random id and is never reused, across devices as within one
  (`vault-events.md` §2). The Ed25519 and X25519 halves are derived
  independently — no Ed→X conversion — so that a hardware signer can
  one day hold one while software holds the other.
- **`stored`** is a key that was not derived here: brought in from
  elsewhere, or made at random for a purpose the seed should not be
  able to reproduce. Its entry carries `jwe`, the private OKP JWK
  (RFC 8037) sealed under the device's key-encryption key (§4.2).
  Losing the entry loses the key; the log's name and public DID do not
  bring it back. This is the second reason the keystore is the device's
  and not the vault's: `keys[]` is rebuildable from the logs only for
  `seed`.

A name matches `[A-Za-z0-9._/-]+`, appears once, and is never renamed;
`did` is the did:key of the Ed25519 half; `createdAt` is when the
entry was made; readers keep fields they do not know.

### 4.2 The key-encryption key

A `stored` entry's `jwe` is a compact JWE, `alg` `dir`, `enc`
`A256GCM`, under a 256-bit key derived from the seed: HKDF-SHA256, salt
`estoc-keystore`, info `estoc/v4/kek`. No key name can collide with the
info, since a key's info always has a purpose segment (`ed25519`,
`x25519`) where `kek` sits.

The reason is the unlock model, not isolation. After the passphrase is
typed once, what a client holds is the non-extractable HKDF `SeedKey`
(§4.4); everything a device does from then on — mint, sign, decrypt —
derives from it without asking again, and the KEK lets adding or using
a `stored` key be the same: one `deriveBits`, no PBKDF2, no prompt.
The alternatives were worse: sealing each `stored` key under the
passphrase itself (one PBKDF2 per key, and the passphrase asked again
for every add), or leaving the JWK in clear beside a sealed seed.
Binding `stored` keys to the seed forfeits nothing: the seed never
leaves the device and is never backed up (§8), so a seed that leaks is
a device that is compromised, and the `stored` keys were on it anyway.

### 4.3 What the keystore hands out

A `Signer` (sign, public key, DID) and, for keys of this store, a
`DidKeySigner` that adds X25519 agreement. `privateJwks()` is the
escape hatch for a library that runs its own crypto — today, the
DIDComm envelope layer — and is what keeps `external` out of this
version: a key that cannot yield its bytes cannot yet open an envelope
(§9). A `stored` key goes through every path a `seed` key does, since
its bytes are here.

### 4.4 Unlocking

The seed is sealed as a compact JWE, `PBES2-HS512+A256KW` / `A256GCM`,
and unlocked once per session into a `SeedKey`, a non-extractable
WebCrypto HKDF key that can `deriveBits` and nothing else. Where a
client keeps that key between sessions is the client's: the app keeps
it in IndexedDB, where a `CryptoKey` survives structured clone and the
seed bytes are never within reach of script; a daemon keeps it in
process memory and starts locked; a platform keychain is a fine place
for the passphrase. None of these is in this directory and none is
part of the format. The seed itself is never handed out, and never
appears in any form but `seedJwe`.

### 4.5 Earlier documents

`@estoc/keystore`'s version-3 document — the same `seedJwe` and
`keys[]`, no `source` — is read as if every entry said `source: seed`,
and written back as version 4. Versions 1 and 2 are refused, as the
package has always refused them.

## 5. Local state

`event-store.md` §7 defines the three kinds — options, cache, trace —
and what may be done to each; this section is where a device keeps
them: in its own directory, outside the folder a backup zips, so that
no rule of the vault needs an exception for them.

Every piece of local state belongs to an **owner**, in a directory of
its own at the device root:

- `agent/` — the agent's: `options.json` (what this device was told: a
  retention level, whether to run an installed extension here),
  `cache/` (rebuildable; delete at will), `trace/` (what this device
  saw, as segments, pruned whole segments at a time, one directory per
  stream).
- `extensions/<ext>/` — an extension's, mirroring `extensions/<ext>/`
  in the vault (`vault-folder.md` §3.1), the same three; under
  `extensions/` so that named owners and minted ids do not share a
  directory, and so that disposing of an extension is one rule applied
  in two roots (§6).
- `<app>/` — an application's, by a name of its own (`[a-z][a-z0-9-]*`,
  and not `agent`, `extensions`, `damaged`, `device` or `keystore`):
  its fold caches, its view state. The three kinds apply; the shapes
  inside are the owner's.

A trace segment is `<uuidv7>.jsonl` of `LocalEvent`s (`event-store.md`
§7.2); retention goes by segment name and never rewrites a line. A
cache is whatever the owner likes, kept with the change token it was
folded to — a token naming another `instance` is rejected and the fold
restarts (`event-store.md` §7.3). Options are kept until changed. A
reader that finds one kind where another belongs treats the directory
as damaged, not as the other kind.

As `event-store.md` §7.1 has it: an option is what would be wrong to
replicate, and a setting that should follow the identity is an event
in the vault, never a line in this directory.

## 6. Opening

A device opens a vault; nothing else does. In order:

1. Read `device.json` (§3). Absent, the device is born first (§7).
2. Open the vault at `vault`: `config.json` must be version 3
   (`vault-folder.md` §10).
3. Take the device's lock: one process per device. In the browser a
   Web Lock named for the device; on disk a lock file in the device
   directory. The lock is the device's, not the vault's, which is what
   lets two devices share a folder (§2).
4. If `devices/<dev>/` in the vault holds no `device.minted`
   (`vault-events.md` §5), append one — on every open, not the first,
   since a crash between birth and the first append leaves exactly this
   gap, and idempotently. This is the device joining the vault, at the
   vault's level; joining the identity toward its contacts is a
   sibling's vouch (`devices.md` §3.2).
5. Fold the extension lifecycle (`vault-events.md` §7.3) and apply
   every `dispose` owed — the application's first act on any open,
   before any extension is handed its store — so that a purged store a
   snapshot still carried is gone before anything could open it.
6. Unlock (§4.4), or run locked until a UI supplies the passphrase.

```ts
interface Device {
  readonly self: string;                 // dev
  readonly instance: string;
  readonly vault: Vault;                 // event-store.md §9, opened at device.json's `vault`
  readonly keys: Keystore;               // §4: signers by name, never bytes
  local(owner: string): LocalOwner;      // §5: options, cache, trace
  dispose(ext: string): Promise<void>;   // §6: the store in the vault and the local state here
}
```

The keys the agent then brings up are the fold's answer intersected
with the keystore: every key whose `did.minted` this device authored
must be here (§4.1); one that is not is a device whose keystore was
lost or edited — reported, never silently re-minted. A key another
device minted is not this device's and is not looked for.

`dispose(ext)` is the device's operation, decided by the application
from the fold: it removes the extension's store in the vault
(`event-store.md` §9, `vault-folder.md` §3.1) and the extension's local
state here, under the vault store's serialisation, with every handle
dead from the call on. One decision, two roots, one rule.

## 7. Birth, restore, loss

**Birth.** A device is born when a program with no `device.json` is
asked to open or create a vault: it mints `dev` and `instance`, makes
a seed and seals it under the passphrase given, writes `keystore.json`
and then `device.json`. The three are minted together and die
together; there is no device with a `dev` and no seed, and no seed that
is not a device's. Creating a vault at the same time — `config.json`
with the anchor, the anchor minted from this seed under the name
`anchor` — is the identity's birth; the device that did it is the one
that can sign as the anchor, and the vault records which by the
`author` of the anchor's events.

**Restore** is placing a snapshot somewhere and pointing a device at
it (`vault-folder.md` §9.4): a new device, or an existing one that has
lost its folder. The device's first open appends its `device.minted`
(§6), and the imported devices' events are history — visible, their
mediations listed, their outbound not `sent` held as imported
(`vault-events.md` §10) — until the person retires them. There is no
restore *of a device*: a device that is gone is gone with its keys
(below), and the folder does not bring it back.

**Carrying the folder** to another machine and opening it there is
therefore a new device, every time, and never an ambiguous "same
device on a new machine": `dev` did not travel, because the device
directory does not. The forked-self check (`event-store.md` §4.2)
catches the one thing that must not happen — a device *directory*
copied, and both copies writing.

**Loss.** A device lost, wiped or stolen is retired by a decision from
any other device (`device.retired`, `vault-events.md` §5): its events
stay, its mediation stops being a live address, later events from it
are suspect. Its keys are lost with it — every `did/<id>` it minted can
no longer sign or decrypt for the identity — which the identity's
contacts must be told; that is `devices.md` §3.3, and a stolen device
that still answers is `devices.md` §3.4. Nothing here can wipe a device
remotely: a retired device that cooperates deletes its own directory,
and one that does not is what the challenge there exists for.
If the device that held the anchor is the one lost, the anchor's
signing key is lost with it, and what stands in for it is the
pre-commitment the identity kept cold — the rotation design, not this
document.

**Retiring one's own device** — replacing a phone — is the same event,
appended by the device itself or by another, followed by deleting the
directory.

## 8. At rest

The device directory holds the only secrets of the identity, and holds
them like this: the seed is `seedJwe`, under the passphrase; every
`stored` key is under the KEK, hence under the passphrase; the unlocked
`SeedKey` a client caches is non-extractable and, in the browser, out
of script's reach. Everything else here — `dev`, key names, DIDs,
options, caches, trace — is plaintext, as the vault is. Whether the
directory as a whole is encrypted at rest is the platform's (full-disk
encryption, the origin's isolation) and no client claims more than it
does.

The seed is never backed up, exported, synced, displayed, or derived
from a phrase a person could write down. That is the premise the rest
of the multi-device design rests on, and the reason binding `stored`
keys to it costs nothing (§4.2): the only way a seed leaves is with the
device, and a device that has left is retired.

## 9. Versioning, open

- **Version.** `device.json` carries `version` 1, and a reader refuses
  any other; `keystore.json` carries its own (4), which the package
  refuses at any other value but 3, read once and rewritten (§4.5). The
  folder's version is the vault's (`vault-folder.md` §10); version 1 of
  the device goes with version 3 of the folder, and neither reads the
  other's number.
- **`external`.** The third source is named (§4.1) and not read: an
  entry with it is refused by this version, since nothing could use
  it. Its first use is signing only — an anchor on a hardware wallet
  signing a card or a vouch, which never opens a DIDComm envelope — and
  is possible as soon as the agent stops needing `privateJwks()` for a
  key that never receives; receiving on an `external` key needs an
  envelope layer that can call out to a signer for ECDH, a project of
  its own, which would make a non-extractable WebCrypto key one more
  `external` holder.
- **The passphrase.** One per device, sealing that device's seed; two
  devices of one identity have two. Whether a client offers a platform
  keychain in its place is the client's. Changing it re-seals `seedJwe`
  and nothing else.
- **`vault` as a pointer.** A path on disk is a poor name for
  something the person may move. Whether `device.json` should also
  record the vault's identity — `config.json`'s anchor — so that a
  device pointed at the wrong folder refuses rather than joins it, is
  worth deciding before implementation: the refusal costs nothing and
  the join is the mistake that is hard to undo.
- **Several devices in one state directory.** Where the host keeps
  more than one (`devices/<dev>/`), it names them by `dev`; whether it
  keeps a list or reads the directories is the host's.
