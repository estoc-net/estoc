/**
 * `config.json`: what a vault says about itself. Every DID here is a
 * snapshot recorded at the moment it was minted, not a projection
 * recomputed from keys — the DID a correspondent holds is the one that
 * was handed out, and rotating a mediator later must not silently rename
 * an identity out from under them.
 */

/** A key in the keystore's index, and the DID it was minted as. */
export interface KeyRef {
  /** the entry name in keystore.json (`keys[].name`) */
  key: string;
  did: string;
}

export interface Mediation {
  mediatorDid: string;
  /**
   * The DID the mediator knows this vault by. No service: its mail is
   * picked up from the mediator, never pushed to an endpoint.
   */
  me: KeyRef;
  /** the mediator's routing DID from mediate-grant; null until granted */
  routingDid: string | null;
  /**
   * The public DID correspondents write to — a did:peer:4 whose service is
   * the routing DID. Minted after the grant; null until then.
   */
  public: KeyRef | null;
}

export interface VaultConfig {
  format: "estoc";
  version: 1;
  /** human label for this vault (the profile's display name in the demo) */
  label: string;
  identity: {
    /** the did:key root: index 0 of the seed, the anchor everything else hangs off */
    anchor: KeyRef;
  };
  mediation: Mediation | null;
}

function isKeyRef(value: unknown): value is KeyRef {
  const ref = value as Partial<KeyRef> | null;
  return (
    typeof ref === "object" &&
    ref !== null &&
    typeof ref.key === "string" &&
    typeof ref.did === "string"
  );
}

export function parseConfig(json: string): VaultConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`config.json is not JSON: ${(err as Error).message}`);
  }
  const config = raw as Partial<VaultConfig> | null;
  if (typeof config !== "object" || config === null || config.format !== "estoc") {
    throw new Error("config.json is not an estoc vault config");
  }
  if (config.version !== 1) {
    throw new Error(`unsupported vault version: ${String(config.version)}`);
  }
  if (typeof config.label !== "string") {
    throw new Error('config.json is missing a string "label"');
  }
  if (!isKeyRef(config.identity?.anchor)) {
    throw new Error("config.json is missing identity.anchor");
  }
  let mediation: Mediation | null = null;
  if (config.mediation !== null && config.mediation !== undefined) {
    const m = config.mediation as Partial<Mediation>;
    if (typeof m.mediatorDid !== "string" || !isKeyRef(m.me)) {
      throw new Error("config.json has a malformed mediation section");
    }
    if (m.routingDid !== null && typeof m.routingDid !== "string") {
      throw new Error("config.json mediation.routingDid must be a string or null");
    }
    if (m.public !== null && !isKeyRef(m.public)) {
      throw new Error("config.json mediation.public must be a key ref or null");
    }
    mediation = {
      mediatorDid: m.mediatorDid,
      me: m.me,
      routingDid: m.routingDid ?? null,
      public: m.public ?? null,
    };
  }
  return {
    format: "estoc",
    version: 1,
    label: config.label,
    identity: { anchor: config.identity.anchor },
    mediation,
  };
}
