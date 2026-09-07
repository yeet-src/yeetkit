/* Tailwind, entirely on the host.
 *
 * This is the part that stays conventional. The isolate emits class
 * names as ordinary attribute values; Tailwind scans the same sources
 * the bundler compiles and writes a stylesheet the dev server serves.
 * Nothing about the class strings changes because the component
 * rendering them lives in an isolate, so every Tailwind feature —
 * arbitrary values, variants, `@apply`, a theme block in CSS — works
 * unmodified.
 *
 * The one wrinkle is resolution. An application depends on yeetkit,
 * not on Tailwind, so `@import "tailwindcss"` has nothing to resolve
 * against in the project. The input is therefore generated: it holds
 * the user's `app/globals.css` verbatim with that one import rewritten
 * to an absolute path, and it is written *into* `app/` so every other
 * relative path in their stylesheet still means what it said.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** `@import "tailwindcss"`, with or without a subpath or a layer. */
const TAILWIND_IMPORT = /@import\s+["']tailwindcss(\/[\w-]+)?["'][^;]*;/g;

const GENERATED = ".yeetkit.css";

export async function startTailwind({ root, appDir, out, watch, onBuild, log }) {
  let tailwindCss;
  let bin;
  try {
    tailwindCss = require.resolve("tailwindcss/index.css");
    /* The CLI's executable is not in its export map, so it is found
     * through the package manifest's `bin` rather than resolved. */
    const manifest = require.resolve("@tailwindcss/cli/package.json");
    const { bin: entry } = require(manifest);
    bin = join(dirname(manifest), typeof entry === "string" ? entry : Object.values(entry)[0]);
  } catch {
    log?.("error", "tailwind is not installed — the stylesheet will be empty");
    await writeFile(join(out, "styles.css"), "");
    return null;
  }

  const user = await readFile(join(appDir, "globals.css"), "utf8").catch(() => null);
  const base = `@import ${JSON.stringify(tailwindCss)};`;

  /* Scanning is anchored to `app/` absolutely, so it does not depend
   * on where the generated file ended up or on the user remembering
   * an `@source`. */
  const body = user
    ? TAILWIND_IMPORT.test(user)
      ? user.replace(TAILWIND_IMPORT, base)
      : `${base}\n${user}`
    : base;

  const input = join(appDir, GENERATED);
  await writeFile(input, `${body}\n@source ${JSON.stringify(appDir)};\n`);

  const output = join(out, "styles.css");
  const argv = [bin, "--input", input, "--output", output];
  if (watch) argv.push("--watch");

  /* stdin is a pipe, not `ignore`, and that is load-bearing: the CLI
   * treats an EOF on stdin as a shutdown signal, so `--watch` against
   * /dev/null exits with status 0 and writes nothing at all. Handing
   * it a pipe nobody closes is what keeps the watcher alive.
   */
  const child = spawn(process.execPath, argv, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    /* Tailwind reports a finished build on stderr; that is the cue to
     * reload, and anything else is worth putting in front of someone. */
    if (/Done in|Built in|rebuilding/i.test(text)) onBuild?.();
    else if (/error/i.test(text)) log?.("error", `tailwind: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  });

  /* A watcher that dies takes the stylesheet with it, and silently:
   * without this the page just stops picking up new classes. */
  if (watch) {
    child.on("exit", (code) => log?.("error", `tailwind exited (${code}) — styles will not update`));
    child.on("error", (error) => log?.("error", `tailwind failed to start: ${error.message}`));
  }

  if (!watch) {
    await new Promise((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tailwind exited ${code}`))));
    });
    return null;
  }

  return { stop: () => child.kill("SIGTERM") };
}
