import { didHost, resolveMediatorInput } from "@estoc/agent-core";

export { resolveMediatorInput };

/**
 * Known mediators. The default is Estoc's own mediator on Cloudflare
 * Workers under its did:web name — a mediator's DID is a function of its
 * keys and URL, and did:web is the name that stays put. The local entry is
 * `npm run dev` in the mediator repo: every checkout mints its own keys,
 * so there is no DID to hardcode — the entry is the URL, probed for its
 * DID at selection time.
 *
 * A fork points the demo at its own mediator without touching this file:
 * VITE_MEDIATOR_DID at build time (e.g. in .env.production) replaces the
 * Estoc entry as the default dropdown choice, labelled by the host its
 * DID names.
 */

export const ESTOC_MEDIATOR_WEB = "did:web:mediator.estoc.dev";
export const ESTOC_MEDIATOR_URL = "https://mediator.estoc.dev";

const CUSTOM_MEDIATOR = import.meta.env.VITE_MEDIATOR_DID?.trim();

export interface MediatorChoice {
  label: string;
  /** A DID, or a URL to probe for one when chosen. */
  value: string;
  /**
   * Take the probed mediator's DID with this prefix instead of its primary.
   * A mediator's peer DIDs are functions of its live keys, so they can only
   * be asked for, never hardcoded — the entry names the method, the probe
   * supplies the name.
   */
  prefer?: string;
}

const LOCAL_CHOICE: MediatorChoice = {
  label: "localhost:8080",
  value: "http://localhost:8080",
};

/**
 * The did:peer:2 alias of the same production mediator. Some correspondents
 * (demo.didcomm.org among them) mis-resolve a did:web routing DID whose
 * document carries JWK material; a profile minted on the peer:2 name routes
 * around that, since did:peer:2 inlines multibase keys and plain URLs.
 */
const ESTOC_PEER2_CHOICE: MediatorChoice = {
  label: "mediator.estoc.dev (did:peer:2)",
  value: ESTOC_MEDIATOR_URL,
  prefer: "did:peer:2",
};

export const MEDIATOR_CHOICES: MediatorChoice[] =
  CUSTOM_MEDIATOR !== undefined && CUSTOM_MEDIATOR !== ""
    ? [
        {
          label: didHost(CUSTOM_MEDIATOR) ?? "custom mediator",
          value: CUSTOM_MEDIATOR,
        },
        LOCAL_CHOICE,
      ]
    : [
        { label: "mediator.estoc.dev", value: ESTOC_MEDIATOR_WEB },
        ESTOC_PEER2_CHOICE,
        LOCAL_CHOICE,
      ];

/** A human name for a mediator DID: the known label, or its HTTP endpoint host. */
export function mediatorLabel(did: string): string {
  const known = MEDIATOR_CHOICES.find((choice) => choice.value === did);
  if (known !== undefined) {
    return known.label;
  }
  return didHost(did) ?? "custom mediator";
}
