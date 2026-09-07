/* Change detection by polling.
 *
 * A watcher would be a dependency with a native build step, and this
 * loop has to survive a source tree mounted into a VM — where inotify
 * across the mount is exactly the thing that does not fire. Statting
 * a few hundred files three times a second is not the expensive part
 * of a rebuild.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SOURCE = /\.(jsx?|mjs|tsx?|css|html|json|c|h)$/;
const SKIP = new Set(["node_modules", ".git", ".yeetkit", "dist", ".build", "bin"]);
/* Tailwind's generated input lives in `app/`; noticing it change would
 * restart the isolate for a stylesheet edit. */
const IGNORE = new Set([".yeetkit.css"]);

export async function sources(dirs, ...extra) {
  const found = [];

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (SOURCE.test(entry.name) && !IGNORE.has(entry.name)) found.push(path);
    }
  };

  for (const dir of [...dirs, ...extra].filter(Boolean)) await walk(dir);
  return found;
}

export function watchLoop({ list, interval, onChange }) {
  const seen = new Map();
  let priming = true;

  const tick = async () => {
    const files = await list();
    const changed = [];
    const present = new Set(files);

    for (const file of files) {
      const at = (await stat(file).catch(() => null))?.mtimeMs;
      if (at === undefined) continue;
      if (seen.get(file) !== at) {
        if (!priming) changed.push(file);
        seen.set(file, at);
      }
    }
    /* A deleted file is a change too — it can remove a route. */
    for (const file of [...seen.keys()]) {
      if (!present.has(file)) {
        seen.delete(file);
        if (!priming) changed.push(file);
      }
    }

    priming = false;
    if (changed.length > 0) await onChange(changed);
  };

  const run = async () => {
    for (;;) {
      await tick().catch((error) => console.error(error));
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  };

  run();
}
