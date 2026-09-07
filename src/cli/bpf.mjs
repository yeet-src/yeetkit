/* Compiling bpf/*.bpf.c, and getting the result to where it is imported.
 *
 * The compiler is not ours: `make bpf` in the project runs clang and
 * bpftool from the pinned static toolchain that build/toolchain.mk
 * fetches once into a shared per-machine cache. yeetkit only decides
 * *when* to run it, and then puts the linked object next to the bundle
 * that imports it.
 *
 * That last part is the whole trick. A `.bpf.o` import is left external
 * — the isolate's loader resolves it at runtime and hands back a
 * `BpfObject` — which means the specifier in the bundle is resolved
 * relative to the bundle, not to the source file it was written in. So
 * the object is copied to `<bundle>/bin/` and the specifier rewritten
 * to match, and an import that read `../../bin/app.bpf.o` in `app/lib/`
 * keeps working from `.yeetkit/` and from `dist/` alike.
 */

import { spawn } from "node:child_process";
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const exists = (path) => access(path).then(() => true, () => false);

/** The linked object every `bpf/*.bpf.c` ends up in. */
export const OBJECT = "app.bpf.o";

/** Does this project have BPF sources at all? */
export async function hasBpf(root) {
  if (!(await exists(join(root, "Makefile")))) return false;
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(join(root, "bpf")).catch(() => []);
  return entries.some((name) => name.endsWith(".bpf.c"));
}

/* Runs the project's own `make bpf`. Its output is passed through
 * rather than summarised: a verifier rejection or a clang error is the
 * most useful thing on the screen when it happens, and rewriting it
 * would only lose the line numbers.
 */
export function make(root, target = "bpf") {
  return new Promise((resolve) => {
    const child = spawn("make", [target], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    child.on("error", (error) =>
      resolve({ ok: false, output: `make could not run: ${error.message}` }),
    );
    child.on("exit", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

/** Copies the linked object to where the bundle's import will look. */
export async function place(root, outDir) {
  const from = join(root, "bin", OBJECT);
  if (!(await exists(from))) return null;

  const to = join(outDir, "bin", OBJECT);
  await mkdir(join(outDir, "bin"), { recursive: true });
  await copyFile(from, to);
  return (await stat(to)).size;
}

/* Every `.bpf.o` import, wherever it was written, resolves to the one
 * object beside the bundle. It stays external: the isolate's loader is
 * what turns the specifier into a `BpfObject`, and inlining the bytes
 * would produce a module the loader has no rule for.
 */
export function bpfImports({ side }) {
  return {
    name: "bpf-objects",
    setup(build) {
      /* Both spellings land here: `#/app.bpf.o`, and a relative path
       * to the same object for anyone who prefers to see it. */
      build.onResolve({ filter: /(^#\/|\.bpf\.o$)/ }, (args) => {
        if (!args.path.endsWith(".bpf.o")) {
          return {
            errors: [
              {
                text: `"${args.path}" is not a BPF object`,
                notes: [{ text: `"#/" names the linked objects; try "#/${OBJECT}".` }],
              },
            ],
          };
        }

        if (side !== "server") {
          return {
            errors: [
              {
                text: `a BPF object can only be loaded in the isolate`,
                notes: [
                  {
                    text:
                      `"${basename(args.path)}" was imported from ${args.importer}. Move the ` +
                      `load into a "use yeet" module and call that instead.`,
                  },
                ],
              },
            ],
          };
        }
        return { path: `./bin/${basename(args.path)}`, external: true };
      });
    },
  };
}
