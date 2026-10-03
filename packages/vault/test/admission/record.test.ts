import type { Held } from "@estoc/event-store";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import { admissionDrafts, admitReceipts, foldVault, foldVaultChecked, rawCidOfBytes, reconcileAdmissions, scanVault, type Keys } from "../../src/index.js";
import { HASH, Scene, expectOrderFree, vaultOf } from "../fold/helpers.js";
import { blocked, noObjects, observation, proof, receipt, resolved, shortIssuerProof, vaults, type Local, type Peer } from "../fold/scene.js";

const fold = (scene: Scene, keys: Keys | null) => foldVaultChecked(scene.set(), keys, noObjects);

const OTHER_HASH = "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA";

describe("admitting receipts", () => {
  it("records, round by round, the first eligible observation of each input in canonical event order, each round judged against what the earlier ones admitted: a consistent duplicate is admitted next, a contradicting one refused for good, a superseded or denied one passed over, and one waiting for evidence holds up nothing", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2, b3 } = await vaults();
    const wire = uuidv7();
    const plain = (local: Local, peer: Peer, overrides: Parameters<typeof receipt>[1]["overrides"] = {}) =>
      observation(scene, { local, peer, resolution: resolved(scene, local.didId, peer), overrides });
    const input = (hash = HASH) => observation(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b0), wire, overrides: { intentHash: hash as never } });
    const opening = input();
    const contradicting = input(OTHER_HASH);
    const consistent = input();
    const elsewhere = plain(a1, b0);
    const unresolved = plain(a0, b1, { peerResolutionEventCid: rawCidOfBytes(new Uint8Array(32).fill(3)) as never });
    const carrier = observation(scene, { local: a0, peer: b3, resolution: resolved(scene, a0.didId, b3), fromPrior: await proof(peerKeys, b2, b3) });
    const superseded = plain(a0, b2);
    blocked(scene, a1, b1);
    const denied = plain(a1, b1);

    const vault = await fold(scene, keys);
    expect(admissionDrafts(vault).map((draft) => draft.data.sourceEventCid)).toEqual([opening.cid, elsewhere.cid, carrier.cid]);
    expectOrderFree(scene.events, (set) => admissionDrafts(foldVault(set, vault.checks)).map((draft) => draft.data.sourceEventCid));

    const memory = await vaultOf(scene);
    const admitted = await memory.locked(async (held) => admitReceipts(held, await scanVault(held, keys)));
    expect(admitted.events.map((event) => event.data.sourceEventCid)).toEqual([opening.cid, elsewhere.cid, carrier.cid, consistent.cid]);
    expect(admitted.fold.dispositions.candidates.map(({ source, eligibility }) => [source.event.cid, eligibility.status])).toEqual([
      [contradicting.cid, "refused"],
      [unresolved.cid, "deferred"],
      [superseded.cid, "refused"],
      [denied.cid, "refused"],
    ]);
    const execution = admitted.fold.inbound.ofSource(opening.cid)!;
    expect([execution.status, execution.members.map(({ admitted: isAdmitted }) => isAdmitted), execution.contradicting.map(({ source }) => source.event.cid)]).toEqual([{ status: "complete" }, [true, false, true], [contradicting.cid]]);
    expect(await reconcileAdmissions(memory, keys)).toEqual([]);
    const after = await scanVault(memory.vault, keys);
    expect([...after.admissions.admissions.values()].map(({ event, status }) => [event.data.sourceEventCid, status.status]).sort()).toEqual(admitted.events.map((event) => [event.data.sourceEventCid, "effective"]).sort());
  });

  it("admits the contradicting observation instead when it comes first in canonical event order, whatever order the events are read in; a commit the disk refuses ends the pass with the rounds before it durable, one whose answer is lost leaves its round durable all the same, and the next pass goes on from what is durable, admitting nothing twice", async () => {
    const { scene, keys, a0, b0, b1 } = await vaults();
    const wire = uuidv7();
    const input = (hash: string, at?: string) => observation(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b0), wire, overrides: { intentHash: hash as never } }, { at });
    const later = input(HASH, "2026-09-12T00:00:01.000Z");
    const earlier = input(OTHER_HASH, "2026-09-12T00:00:00.000Z");
    const other = observation(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1) });
    const consistent = input(OTHER_HASH);
    const vault = await fold(scene, keys);
    expect(admissionDrafts(vault).map((draft) => draft.data.sourceEventCid)).toEqual([earlier.cid, other.cid]);

    const memory = await vaultOf(scene);
    const durable = async () => (await scanVault(memory.vault, keys)).set.of("message.admitted").map((event) => event.data.sourceEventCid).sort();
    /** The held view with its commit failing at the `at`th: refused before anything is written, or its answer lost once the write is durable. */
    const failing = (held: Held, at: number, how: "refused" | "lost"): Held => {
      let commits = 0;
      const faulty = Object.create(held) as Held;
      faulty.commit = async (objects, drafts) => {
        if (commits++ !== at) return held.commit(objects, drafts);
        if (how === "refused") throw new Error("the disk is full for now");
        await held.commit(objects, drafts);
        throw new Error("the disk answered nothing");
      };
      return faulty;
    };
    await expect(memory.locked(async (held) => admitReceipts(failing(held, 1, "refused"), await scanVault(held, keys)))).rejects.toThrow("the disk is full for now");
    expect(await durable()).toEqual([earlier.cid, other.cid].sort());
    await expect(memory.locked(async (held) => admitReceipts(failing(held, 0, "lost"), await scanVault(held, keys)))).rejects.toThrow("the disk answered nothing");
    expect(await durable()).toEqual([earlier.cid, other.cid, consistent.cid].sort());

    expect(await reconcileAdmissions(memory, keys)).toEqual([]);
    const after = await scanVault(memory.vault, keys);
    expect(after.inbound.ofSource(later.cid)).toMatchObject({ status: { status: "complete" }, intentHash: OTHER_HASH, contradicting: [{ source: { event: { cid: later.cid } } }] });
    expect(after.inbound.ofSource(later.cid)!.members.map(({ source, admitted }) => [source.event.cid, admitted])).toEqual([
      [earlier.cid, true],
      [later.cid, false],
      [consistent.cid, true],
    ]);
    expect(after.dispositions.disposition(later.cid)).toEqual({ status: "pending-admission", because: "the observation contradicts the intent its input has admitted" });
  });

  it("leaves every observation waiting for its proof's issuer unadmitted, however many one writer records of the input; once the document is here the eligible ones are judged in canonical event order, not the order they were received in", async () => {
    const { scene, keys, peerKeys, a0, b2, b3 } = await vaults();
    const wire = uuidv7();
    const fromPrior = await shortIssuerProof(peerKeys, b2, b3);
    const resolution = resolved(scene, a0.didId, b3);
    const input = (hash: string, at: string) => observation(scene, { local: a0, peer: b3, resolution, wire, fromPrior, overrides: { intentHash: hash as never } }, { at });
    const first = input(HASH, "2026-09-12T00:00:01.000Z");
    const second = input(OTHER_HASH, "2026-09-12T00:00:00.000Z");
    const waiting = await fold(scene, keys);
    const deferred = { status: "deferred", because: "the source's proof is not yet verified" };
    expect(waiting.dispositions.candidates.map(({ source, eligibility }) => [source.event.cid, eligibility])).toEqual([[second.cid, deferred], [first.cid, deferred]]);
    expect(admissionDrafts(waiting)).toEqual([]);

    resolved(scene, a0.didId, b2);
    const ready = await fold(scene, keys);
    expect(ready.dispositions.candidates.map(({ source, eligibility }) => [source.event.cid, eligibility])).toEqual([[second.cid, { status: "eligible" }], [first.cid, { status: "eligible" }]]);
    const memory = await vaultOf(scene);
    expect((await reconcileAdmissions(memory, keys)).map((event) => event.data.sourceEventCid)).toEqual([second.cid]);
    const after = await scanVault(memory.vault, keys);
    expect(after.inbound.ofSource(first.cid)).toMatchObject({ status: { status: "complete" }, intentHash: OTHER_HASH, contradicting: [{ source: { event: { cid: first.cid } } }] });
    expect(after.dispositions.disposition(first.cid)).toEqual({ status: "pending-admission", because: "the observation contradicts the intent its input has admitted" });
  });
});
