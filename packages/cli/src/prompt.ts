import { createInterface } from "node:readline";

/**
 * Passphrase prompting. On a TTY the input is read in raw mode with echo
 * suppressed (sudo style — nothing is printed while typing). When stdin is
 * not a TTY, one line per prompt is consumed instead, so scripts and tests
 * can pipe passphrases in: `printf 'pw\npw\n' | estoc init`.
 *
 * `ESTOC_PASSPHRASE` in the environment answers every prompt without
 * asking. Prompts go to stderr; stdout stays reserved for command output.
 */

let pipedLines: AsyncIterator<string> | null = null;

async function readPipedLine(): Promise<string> {
  if (!pipedLines) {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    pipedLines = rl[Symbol.asyncIterator]();
  }
  const line = await pipedLines.next();
  if (line.done) throw new Error("stdin closed while waiting for a passphrase");
  return line.value;
}

function readHiddenLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    let entered = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\x04") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(entered);
          return;
        }
        if (ch === "\x03") {
          // Ctrl-C: restore the terminal before dying.
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") {
          entered = entered.slice(0, -1);
        } else if (ch >= " ") {
          entered += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

export async function promptPassphrase(promptText = "passphrase: "): Promise<string> {
  const fromEnv = process.env["ESTOC_PASSPHRASE"];
  if (fromEnv !== undefined) return fromEnv;
  return process.stdin.isTTY ? readHiddenLine(promptText) : readPipedLine();
}

/** Ask twice for a passphrase that seals a new key; must match, non-empty. */
export async function promptNewPassphrase(): Promise<string> {
  const first = await promptPassphrase("passphrase: ");
  if (first.length === 0) throw new Error("passphrase must not be empty");
  const second = await promptPassphrase("repeat passphrase: ");
  if (first !== second) throw new Error("passphrases do not match");
  return first;
}
