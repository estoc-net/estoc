/// <reference types="vite-plugin-pwa/client" />

declare module "didcomm/index_bg.js" {
  export * from "didcomm";
  export function __wbg_set_wasm(exports: unknown): void;
}

declare module "didcomm/index_bg.wasm?url" {
  const url: string;
  export default url;
}

// Vite statically replaces import.meta.env.* at build time; only the keys
// declared here are read.
interface ImportMetaEnv {
  /** Build-time default mediator DID; unset means Estoc's mediator. */
  readonly VITE_MEDIATOR_DID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
