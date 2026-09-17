import { MemoryVault, type Event } from "@estoc/event-store/v3";
import { importSeed } from "@estoc/keystore";
import { describe, expect, it } from "vitest";

import { Keys, checkVault, foldVault, objectReader, rawCidOfBytes, scanVault, VaultEventSet, type VaultChecks, type VaultFold } from "../../../src/v3/index.js";
import { SEED, expectOrderFree } from "./helpers.js";
import { intent, noObjects, packageOf, receipt, resolved, vaults } from "./scene.js";

const encoder = new TextEncoder();

/** The fold without the set it was read from, since the set keeps its events in arrival order. */
const readable = ({ set, ...fold }: VaultFold) => (expect(set).toBeInstanceOf(VaultEventSet), fold);

async function memoryVault(events: readonly Event[]): Promise<MemoryVault> {
  const vault = new MemoryVault({ metadata: { version: 3, anchor: await Keys.anchorOf(await importSeed(SEED)) } });
  await vault.ingest(events);
  return vault;
}

describe("the whole fold", () => {
  it("feeds every fold the ones it reads, holds what they retain, and is the same over every order of the events", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    scene.add("identity.label", { name: "me" });
    const inbound = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const out = intent(scene, a0, b0);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [pkg.data.envelopeCid], because: "user" });
    const checks = await checkVault(VaultEventSet.of(scene.events), keys, noObjects);
    expect(checks.didKeys.get(a0.didId)).toBe("verified");
    expect(checks.resolutionChecks.get(root.eventId)).toBe("verified");
    const check = (fold: VaultFold) => {
      expect(fold.label).toBe("me");
      expect(fold.authors).toHaveLength(1);
      expect(fold.mediations.preferred).not.toBeNull();
      expect(fold.routes.dids.get(a0.didId)!.live).toBe(true);
      expect(fold.erasures.get(out.data.messageId)).toEqual(new Set([pkg.data.envelopeCid]));
      expect(fold.held).toEqual(new Set([root.data.documentCid, inbound.data.bodyCid, out.data.bodyCid]));
      expect(fold.retained.filter((edge) => edge.eventId === pkg.eventId)).toEqual([]);
      expect(fold.retained.filter((edge) => edge.eventId === out.eventId)).toEqual([{ eventId: out.eventId, root: out.data.bodyCid }]);
    };
    check(foldVault(VaultEventSet.of(scene.events), checks));
    expectOrderFree(scene.events, (set) => readable(foldVault(set, checks)));
  });

  it("scans a vault in one motion, the seed deciding liveness and the objects deciding what a reader hands the checks", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    resolved(scene, a0.didId, b0);
    const vault = await memoryVault(scene.events);
    const seeded = await scanVault(vault.vault, keys);
    expect(seeded.routes.dids.get(a0.didId)!.live).toBe(true);
    const unseeded = await scanVault(vault.vault, null);
    expect(unseeded.routes.dids.get(a0.didId)).toMatchObject({ live: false, identity: "unchecked" });
    expect(unseeded.checks.didKeys.size).toBe(0);

    const hello = encoder.encode("hello");
    const cid = rawCidOfBytes(hello);
    await vault.stores.objects.putObject(cid, hello);
    const read = objectReader(vault.vault.objects);
    expect(await read(cid)).toEqual(hello);
    expect(await read(rawCidOfBytes(encoder.encode("absent")))).toBeNull();
    expect(await objectReader(vault.vault.objects, 2)(cid)).toBeNull();
    vault.stores.objects.damage(cid);
    expect(await read(cid)).toBeNull();
    const checks: VaultChecks = {};
    expect(foldVault(VaultEventSet.of(scene.events), checks).checks.resolutionChecks.size).toBe(0);
  });
});
