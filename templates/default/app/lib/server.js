"use server";

/* Runs in the Node process supervising the isolate — where npm is.
 *
 * `fs`, `fetch`, a database driver, anything from node_modules: this
 * is the only one of the three runtimes that has them. The isolate has
 * no filesystem and no network; the browser has no business holding a
 * connection string.
 *
 * And it is not cut off from the host data. Importing a `"use yeet"`
 * function here compiles to a call over the same socket the hub
 * already holds, so one function can read a file *and* the process
 * table without either runtime having to pretend to be the other.
 */
import { readFile } from "node:fs/promises";
import { hostname, loadavg } from "node:os";
import { join } from "node:path";

import { processCount } from "./host.js";

export async function snapshot() {
  const [manifest, processes] = await Promise.all([
    /* `process.cwd()`, not `import.meta.url`: this module is bundled,
     * so a path relative to the source file resolves against the
     * bundle's location instead. The host runs from the project root. */
    readFile(join(process.cwd(), "package.json"), "utf8")
      .then((text) => JSON.parse(text).name)
      .catch(() => "unknown"),
    /* Over the wire, into the isolate, and back. */
    processCount(),
  ]);

  return {
    project: manifest,
    host: hostname(),
    load: loadavg()[0].toFixed(2),
    processes,
    node: process.version,
  };
}
