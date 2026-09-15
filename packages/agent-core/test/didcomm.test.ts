import { describe, expect, it } from "vitest";

import { packEncrypted, packFromPrior, secretsResolverFor, unpackMessage, type DidcommApi, type IMessage } from "../src/protocol/didcomm.js";
import { bounded } from "../src/v3/link.js";

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

/** A binding whose native objects record their frees, and whose every call settles only when the test settles it. */
function binding() {
  const freed: string[] = [];
  const calls: Pending[] = [];
  const pending = <T>(): Promise<T> => new Promise<T>((resolve, reject) => calls.push({ resolve: resolve as (value: unknown) => void, reject }));
  class Message {
    constructor(readonly value: IMessage) {}
    pack_encrypted(): Promise<[string, unknown]> {
      return pending();
    }
    as_value(): IMessage {
      return this.value;
    }
    free(): void {
      freed.push(`message ${this.value.id}`);
    }
    static unpack(): Promise<[Message, unknown]> {
      return pending();
    }
  }
  class FromPrior {
    constructor(readonly value: { iss: string }) {}
    pack(): Promise<[string, string]> {
      return pending();
    }
    free(): void {
      freed.push(`from_prior ${this.value.iss}`);
    }
  }
  return { didcomm: { Message, FromPrior } as unknown as DidcommApi, Message, freed, calls };
}

const resolver = { resolve: async () => null };
const secrets = secretsResolverFor([]);
const plain = (id: string): IMessage => ({ id, typ: "application/didcomm-plain+json", type: "https://example.org/t", body: {} }) as IMessage;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the binding's native objects", () => {
  it("a message made for a pack is freed once, when the pack has settled, whether it sealed or failed", async () => {
    const { didcomm, freed, calls } = binding();
    const sealing = packEncrypted(didcomm, plain("m1"), "did:example:to", null, null, resolver, secrets, { forward: false });
    await settled();
    expect(freed).toEqual([]);
    calls[0]!.resolve(["packed", {}]);
    expect(await sealing).toEqual(["packed", {}]);
    const failing = packEncrypted(didcomm, plain("m2"), "did:example:to", null, null, resolver, secrets, { forward: false });
    calls[1]!.reject(new Error("no key to seal to"));
    await expect(failing).rejects.toThrow("no key to seal to");
    expect(freed).toEqual(["message m1", "message m2"]);
  });

  it("an opened message is read out as a plain value and freed; an unpack that fails holds nothing to free", async () => {
    const { didcomm, Message, freed, calls } = binding();
    const opening = unpackMessage(didcomm, "packed", resolver, secrets, {});
    calls[0]!.resolve([new Message(plain("m1")), { encrypted: true }]);
    expect(await opening).toEqual([plain("m1"), { encrypted: true }]);
    const failing = unpackMessage(didcomm, "packed", resolver, secrets, {});
    calls[1]!.reject(new Error("will not open"));
    await expect(failing).rejects.toThrow("will not open");
    expect(freed).toEqual(["message m1"]);
  });

  it("a signed rotation header's object is freed once it is signed", async () => {
    const { didcomm, freed, calls } = binding();
    const signing = packFromPrior(didcomm, { iss: "did:example:old", sub: "did:example:new" }, "did:example:old#key-1", resolver, secrets);
    calls[0]!.resolve(["jwt", "did:example:old#key-1"]);
    expect(await signing).toEqual(["jwt", "did:example:old#key-1"]);
    expect(freed).toEqual(["from_prior did:example:old"]);
  });

  it("a caller that stops waiting at its deadline does not free what the binding still works with: the objects go once the late calls settle", async () => {
    const { didcomm, Message, freed, calls } = binding();
    const sealing = bounded(AbortSignal.timeout(5), () => packEncrypted(didcomm, plain("m1"), "did:example:to", null, null, resolver, secrets, { forward: false }));
    const opening = bounded(AbortSignal.timeout(5), () => unpackMessage(didcomm, "packed", resolver, secrets, {}));
    await expect(sealing).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(opening).rejects.toMatchObject({ name: "TimeoutError" });
    expect(freed).toEqual([]);
    calls[0]!.resolve(["late", {}]);
    calls[1]!.resolve([new Message(plain("m2")), {}]);
    await settled();
    expect(freed).toEqual(["message m1", "message m2"]);
  });
});
