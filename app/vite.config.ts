import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    vue(),
    // The installable half: a manifest, and a service worker that precaches
    // the shell — scripts, styles, the didcomm WASM — so an installed Estoc
    // opens with no network at all. Updates wait for the user's nod
    // (registerType "prompt"; see src/core/pwa.ts).
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Estoc",
        short_name: "Estoc",
        description:
          "An offline-first DIDComm messenger: one identity from one seed, your vault in this browser, a zip you can walk away with.",
        theme_color: "#1d2528",
        background_color: "#eef0f1",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm,svg,png,webmanifest}"],
        // the didcomm WASM is well over workbox's 2 MB default
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // The didcomm package's entry does `import * as wasm from "./index_bg.wasm"`,
  // which only webpack understands. src/didcomm/wasm.ts instantiates the wasm
  // itself and imports the glue module directly; keeping the package out of
  // prebundling makes sure that glue module is the single instance the shim
  // wires up.
  optimizeDeps: { exclude: ["didcomm"] },
  build: { target: "es2022" },
});
