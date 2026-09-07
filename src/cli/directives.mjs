/* Reading the directive prologue, and the exports under it.
 *
 * A module's first statements decide where it runs:
 *
 *   "use client"  an island. Compiled for the DOM and shipped to the
 *                 browser, where it holds its own state and handles
 *                 its own events with no round trip.
 *   "use server"  functions an island may call. They stay in the
 *                 isolate; the browser gets a stub that sends a
 *                 message and awaits the reply.
 *   "use yeet"    isolate-only, enforced. The build fails rather than
 *                 letting this module reach the browser.
 *
 * Everything with no directive at all runs in the isolate, because
 * that is this framework's default and the reason it exists.
 */

import { parseAsync } from "@babel/core";

const KNOWN = new Set(["use client", "use server", "use yeet"]);

/* Only the prologue counts — the run of string-literal statements
 * before the first real one — which is what keeps a `"use client"`
 * sitting in the middle of a file from meaning anything.
 */
export function directiveOf(source) {
  const prologue = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(?:(['"])([^'"]*)\1\s*;?\s*)+/.exec(source);
  if (!prologue) return null;

  for (const match of prologue[0].matchAll(/(['"])([^'"]*)\1/g)) {
    if (KNOWN.has(match[2])) return match[2];
  }
  return null;
}

/* The export names, so the server pass can stand in a placeholder for
 * each one without evaluating the module. Parsing rather than
 * pattern-matching: `export { a as b, c }` and `export default` are
 * both common enough that a regex would be wrong on real code.
 */
export async function exportsOf(source, filename) {
  return (await exportKindsOf(source, filename)).map(([name]) => name);
}

/* The exports, each with what it is: a plain function, or an async
 * generator.
 *
 * The distinction is load-bearing rather than cosmetic. A generator is
 * reachable over the wire as a *stream* — many values, cancellable —
 * and a plain function as a single call, so the two need different
 * stubs on the far side. Asking the AST rather than the value means the
 * decision is made at build time, before anything has been evaluated.
 */
export async function exportKindsOf(source, filename) {
  const ast = await parseAsync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: { plugins: ["jsx", filename.endsWith("x") ? "typescript" : null].filter(Boolean) },
  });

  const kindOf = (node) => (node?.generator && node?.async ? "stream" : "fn");

  /* Local declarations, so `export { tail }` can be told apart from
   * `export function tail()` without a second pass. */
  const local = new Map();
  for (const node of ast.program.body) {
    const declaration = node.type.startsWith("Export") ? node.declaration : node;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      local.set(declaration.id.name, kindOf(declaration));
    }
    for (const declarator of declaration?.declarations ?? []) {
      if (declarator.id?.type === "Identifier") {
        local.set(declarator.id.name, kindOf(declarator.init));
      }
    }
  }

  const found = new Map();
  for (const node of ast.program.body) {
    if (node.type === "ExportDefaultDeclaration") {
      found.set("default", kindOf(node.declaration));
      continue;
    }
    if (node.type !== "ExportNamedDeclaration") continue;

    for (const specifier of node.specifiers ?? []) {
      const exported = specifier.exported.name ?? specifier.exported.value;
      found.set(exported, local.get(specifier.local?.name) ?? "fn");
    }

    const declaration = node.declaration;
    if (!declaration) continue;
    if (declaration.id) found.set(declaration.id.name, kindOf(declaration));
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id.type === "Identifier") {
        found.set(declarator.id.name, kindOf(declarator.init));
      }
    }
  }
  return [...found];
}

/* Finds every module carrying a directive, by walking rather than by
 * following imports.
 *
 * A `"use server"` module is typically imported only by an island — and
 * on the server side an island is replaced by a marker, so that import
 * disappears and the action would never register. Scanning the project
 * instead means an action exists because it was written, not because
 * something happened to reach it.
 */
export async function findModules(dir, directive) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const found = [];
  const skip = new Set(["node_modules", ".git", ".yeetkit", "dist"]);

  const walk = async (at) => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (/\.[jt]sx?$/.test(entry.name)) {
        const source = await readFile(path, "utf8").catch(() => "");
        if (directiveOf(source) === directive) found.push(path);
      }
    }
  };

  await walk(dir);
  return found;
}
