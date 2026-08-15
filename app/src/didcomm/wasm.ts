/**
 * The `didcomm` package for the browser via Vite.
 *
 * The package's own index.js is webpack-shaped: it imports the .wasm expecting
 * the bundler to instantiate it with the glue module's imports wired up. Vite
 * hands out a URL instead, so this file does the wiring itself (the same move
 * as mediator-ts's workerd shim, made async for the browser): every import the
 * wasm declares comes from "./index_bg.js", which is exactly the glue module —
 * instantiate with it, hand the exports back via __wbg_set_wasm, done.
 *
 * `initDidcomm()` must resolve before anything from this module is called.
 */
import wasmUrl from "didcomm/index_bg.wasm?url";
import * as glue from "didcomm/index_bg.js";

let ready: Promise<void> | null = null;

export function initDidcomm(): Promise<void> {
  ready ??= (async () => {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {
      "./index_bg.js": glue as unknown as Record<string, WebAssembly.ImportValue>,
    });
    (glue as { __wbg_set_wasm(exports: unknown): void }).__wbg_set_wasm(
      instance.exports
    );
  })();
  return ready;
}

export * from "didcomm/index_bg.js";
