import { existsSync } from "node:fs";

/** A Chromium to run browser cases in, or null: `ESTOC_BROWSER` names one, else the usual places are tried. */
export function findChromium(): string | null {
  const candidates = [
    process.env["ESTOC_BROWSER"],
    process.env["CHROME_BIN"],
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
