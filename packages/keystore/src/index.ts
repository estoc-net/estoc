export type { Signer, DidKeySigner, SeedKeystoreDocument } from "./types.js";
export { didKeyFromPublicKey, publicKeyFromDidKey } from "./did-key.js";
export {
  generateSeed,
  importSeed,
  deriveIdentity,
  isValidKeyName,
  KEY_NAME_PATTERN,
  SEED_LENGTH,
  type SeedKey,
  type DerivedIdentity,
} from "./seed.js";
export {
  createSeedKeystore,
  unlockSeedKeystore,
  changeSeedPassphrase,
  serializeKeystore,
  parseSeedKeystore,
  type CreateSeedKeystoreOptions,
} from "./seed-keystore.js";
