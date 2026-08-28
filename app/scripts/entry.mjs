// The package's one export: where the built files are. Written after
// `vite build`, so a consumer (estoc serve, estoc-daemon) can locate dist/.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../dist-entry/", import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(
  `${dir}index.js`,
  `import { fileURLToPath } from "node:url";\n/** The directory of the built app: index.html and its assets. */\nexport const appDir = fileURLToPath(new URL("../dist/", import.meta.url));\n`
);
await writeFile(`${dir}index.d.ts`, `/** The directory of the built app: index.html and its assets. */\nexport declare const appDir: string;\n`);
