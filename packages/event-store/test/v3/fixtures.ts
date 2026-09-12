/**
 * A vault's identity for tests, free of any test framework so a case
 * run in a browser Worker can use it too: an anchor DID, and two seeds
 * sealed by `@estoc/keystore` under throwaway passphrases — wrappers of
 * the real profile, for a vault that is never unlocked.
 */

import type { VaultMetadata, WrappedSeed } from "../../src/v3/index.js";

export const ANCHOR = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

export const META: VaultMetadata = { version: 3, anchor: ANCHOR };

export const WRAPPED: WrappedSeed = {
  version: 3,
  seedJwe:
    "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6InpuVWw5VnlkdFkzWnVfM2pDYmdIRVEifQ.Q8DKVfRo5GYAaXt9fFkVrys2S2F1i-9SuzOFTY2nhNBCzKIuQif6bw.DqSkIE5od1rgcNLj.7b04mSTcpW-ZY-cFPKie5MniK8SkCRWakayNtxNWp0s.xrN8O94WtsddKkYIQ_TprA",
};

export const REWRAPPED: WrappedSeed = {
  version: 3,
  seedJwe:
    "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6IjdlVzlpVnNOdk50NGF3SmxsQTJJcWcifQ.q9ssT2NUYbXjbLnGBJzECoj-W5_g6y_eI0KkHob7cBmWRU1IYH25pA.-MSdpryl20FwyPKo.c_IrTpcWA3eAQBVSw-8XDpmqbscf2QuwN2pUGrUlE4U.a5c8z2rg3hkmBQnmOkxCfQ",
};
