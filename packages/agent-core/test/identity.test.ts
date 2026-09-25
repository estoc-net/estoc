import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";

import { openNodeSqlite } from "@estoc/event-store/node";
import { AnchorMismatch, NotAVault, ReadOnlyVault, SnapshotTooLarge, exportVault, type OpenMode } from "@estoc/event-store";
import { createSeedKeystore } from "@estoc/keystore";
import { Keys, vaultDraft, vaultHeldRoots } from "@estoc/vault";

import { createVault, inspectRuntime, inspectSnapshot, openVault } from "../src/index.js";
import { PASSPHRASE, freshVault, memoryDriver, seedOf, ticking } from "./helpers.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-c01-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (file: string, mode: OpenMode) => openNodeSqlite(file, mode === "create" ? { mode, journal: "delete" } : { mode });

describe("the vault opened with the seed", () => {
  it("creates under the seed's anchor with its label, and reopens as the same identity with the seed or the passphrase", async () => {
    const file = fresh();
    const { doc, seedKey } = await createSeedKeystore(PASSPHRASE, { seed: seedOf(1) });
    const made = await createVault(open(file, "create"), { seedKey, wrapped: doc, label: "Alice", now: ticking() });
    expect(made.runtime.metadata.anchor).toBe(await Keys.anchorOf(seedKey));
    expect(made.fold.label).toBe("Alice");
    expect(made.fold.authors.map((author) => author.author)).toEqual([made.runtime.author]);
    await made.runtime.close();

    const bySeed = await openVault(open(file, "readwrite"), seedKey);
    expect(bySeed.runtime.metadata.anchor).toBe(made.runtime.metadata.anchor);
    expect(bySeed.runtime.author).toBe(made.runtime.author);
    expect(bySeed.fold.label).toBe("Alice");
    expect(bySeed.keys.locked).toBe(false);
    await bySeed.runtime.close();

    const byPassphrase = await openVault(open(file, "readwrite"), { passphrase: PASSPHRASE });
    expect(byPassphrase.fold.label).toBe("Alice");
    await byPassphrase.runtime.close();
  });

  it("refuses another seed and a wrong passphrase, closing the driver either way", async () => {
    const file = fresh();
    const made = await freshVault(1, "Alice", open(file, "create"));
    await made.runtime.close();
    const other = await createSeedKeystore(PASSPHRASE, { seed: seedOf(2) });
    await expect(openVault(open(file, "readwrite"), other.seedKey)).rejects.toBeInstanceOf(AnchorMismatch);
    await expect(openVault(open(file, "readwrite"), { passphrase: "wrong" })).rejects.toThrow();
    // the file is not held by the refused opens: it opens again
    const again = await openVault(open(file, "readwrite"), made.seedKey);
    expect(again.fold.label).toBe("Alice");
    await again.runtime.close();
  });
});

describe("the runtime inspected without the seed", () => {
  it("reads the wrapped seed and the fold, writes nothing, and lets the passphrase be checked before a writable open", async () => {
    const file = fresh();
    const made = await freshVault(1, "Alice", open(file, "create"));
    await made.runtime.close();

    const inspected = await inspectRuntime(open(file, "readwrite"));
    expect(inspected.fold.label).toBe("Alice");
    expect(inspected.fold.checks.didKeys.size).toBe(0);
    expect(inspected.wrapped).toEqual({ version: 3, seedJwe: made.keystore.seedJwe });
    expect(inspected.runtime.writable).toBe(false);
    await expect(inspected.runtime.vault.commit([], [vaultDraft("identity.label", { name: "Mallory" })])).rejects.toBeInstanceOf(ReadOnlyVault);
    const keys = await Keys.unlock(inspected.wrapped, PASSPHRASE, inspected.runtime.metadata.anchor);
    expect(keys.locked).toBe(false);
    await expect(Keys.unlock(inspected.wrapped, "wrong", inspected.runtime.metadata.anchor)).rejects.toThrow();
    await inspected.runtime.close();

    const opened = await openVault(open(file, "readwrite"), made.seedKey);
    expect(opened.fold.label).toBe("Alice");
    await opened.runtime.close();
  });
});

describe("a snapshot inspected", () => {
  it("validates the snapshot against its own fold's retention and reads its fold; a runtime file is not a snapshot", async () => {
    const made = await freshVault(1, "Alice");
    const snapshot = fresh();
    const exported = await exportVault(made.runtime, (mode) => open(snapshot, mode), { heldRoots: vaultHeldRoots(made.keys) });
    expect(exported.events).toBe(1);
    await made.runtime.close();

    const inspected = await inspectSnapshot(open(snapshot, "readonly"));
    expect(inspected.validated).toEqual(exported);
    expect(inspected.fold.label).toBe("Alice");
    expect(inspected.snapshot.metadata.anchor).toBe(made.runtime.metadata.anchor);
    inspected.snapshot.close();

    const runtimeFile = fresh();
    const other = await freshVault(2, "Bob", open(runtimeFile, "create"));
    await other.runtime.close();
    await expect(inspectSnapshot(open(runtimeFile, "readonly"))).rejects.toBeInstanceOf(NotAVault);
    const reopened = await openVault(open(runtimeFile, "readwrite"), other.seedKey);
    await reopened.runtime.close();
  });

  test("a snapshot's file bound is enforced before anything is read", async () => {
    const made = await freshVault(1, "Alice");
    const snapshot = fresh();
    await exportVault(made.runtime, (mode) => open(snapshot, mode), { heldRoots: vaultHeldRoots(made.keys) });
    await made.runtime.close();
    await expect(inspectSnapshot(open(snapshot, "readonly"), { maxFileBytes: 1 })).rejects.toBeInstanceOf(SnapshotTooLarge);
  });
});

describe("in memory", () => {
  it("makes and folds a vault on a private in-memory database", async () => {
    const made = await freshVault(3, "Carol", memoryDriver());
    expect(made.fold.label).toBe("Carol");
    await made.runtime.close();
  });
});
