/* The production build: the same pipeline, run once.
 *
 * What it emits is a directory that `yeetkit start` — or a bare `yeet
 * run` plus any static file server — can serve:
 *
 *   dist/server.js    the app, for `yeet run -p tty:ws://...` (plus
 *                     `-p console:ws://...` when built with `direct`)
 *   dist/index.html   the shell
 *   dist/client.js    the browser half
 *   dist/styles.css   Tailwind's output
 *   dist/...          whatever was in public/
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OBJECT, hasBpf, make, place } from "./bpf.mjs";
import { RUNTIME, createBundler, entryModule, islandsModule, nodeModule } from "./bundle.mjs";
import { collectRoutes, renderRouteModule } from "./routes.mjs";
import { findIcon, indexHtml } from "./html.mjs";
import { startTailwind } from "./tailwind.mjs";

export async function build(config) {
  const { root, appDir, publicDir, out, dist, title, direct, consolePort } = config;

  await mkdir(out, { recursive: true });
  await mkdir(dist, { recursive: true });

  /* Before the bundle, which imports what this produces. */
  if (await hasBpf(root)) {
    const result = await make(root);
    if (!result.ok) {
      console.error(result.output);
      throw new Error("bpf build failed");
    }
    await place(root, dist);
  }

  const collected = await collectRoutes(appDir);
  const { code, summary } = renderRouteModule(collected, out);
  await writeFile(join(out, "routes.js"), code);
  await writeFile(join(out, "entry.jsx"), await entryModule({ title, appDir, out, direct }));

  const islands = new Set();
  const actions = new Set();
  const isolateFns = new Set();

  const bundler = await createBundler({
    entry: join(out, "entry.jsx"),
    outfile: join(dist, "server.js"),
    dev: false,
    root,
    appDir,
    side: "server",
    islands,
    actions,
    isolateFns,
  });

  const result = await bundler.rebuild().catch((error) => error);
  await bundler.dispose();

  if (result?.errors?.length) {
    for (const error of result.errors) console.error(`error: ${error.text}`);
    throw new Error("build failed");
  }

  /* Second, because the server pass is what discovers the islands. */
  const islandEntry = join(out, "islands.jsx");
  await writeFile(islandEntry, islandsModule(islands, { root, out }));

  const islandBundler = await createBundler({
    entry: islandEntry,
    outfile: join(dist, "islands.js"),
    dev: false,
    root,
    appDir,
    side: "client",
    islands,
    actions,
    isolateFns,
  });
  const islandResult = await islandBundler.rebuild().catch((error) => error);
  await islandBundler.dispose();

  /* The host's bundle. It stays out of `dist/` as a separate file that
   * `yeetkit start` imports — it is the only one of the three that
   * runs in this process rather than being shipped somewhere. */
  const nodeEntry = join(out, "node-entry.js");
  await writeFile(nodeEntry, await nodeModule({ appDir, root, out }));

  const nodeBundler = await createBundler({
    entry: nodeEntry,
    outfile: join(dist, "node.js"),
    dev: false,
    root,
    appDir,
    side: "node",
    islands,
    actions,
    isolateFns,
  });
  const nodeResult = await nodeBundler.rebuild().catch((error) => error);
  await nodeBundler.dispose();

  if (nodeResult?.errors?.length) {
    for (const error of nodeResult.errors) console.error(`error: ${error.text}`);
    throw new Error("host build failed");
  }

  if (islandResult?.errors?.length) {
    for (const error of islandResult.errors) {
      console.error(`error: ${error.text}`);
      for (const note of error.notes ?? []) console.error(`  ${note.text}`);
    }
    throw new Error("island build failed");
  }

  await startTailwind({ root, appDir, out, watch: false });
  await cp(join(out, "styles.css"), join(dist, "styles.css")).catch(() => {});
  await cp(join(RUNTIME, "..", "client", "client.js"), join(dist, "client.js"));
  await writeFile(
    join(dist, "index.html"),
    indexHtml({ title, dev: false, direct: direct ? consolePort : null, icon: await findIcon(publicDir) }),
  );
  await cp(publicDir, dist, { recursive: true }).catch(() => {});

  const bpfSize = (await readFile(join(dist, "bin", OBJECT)).catch(() => "")).length;
  const size = (await readFile(join(dist, "server.js"))).length;
  const islandSize = (await readFile(join(dist, "islands.js")).catch(() => "")).length;

  console.log(`built ${summary.length} route${summary.length === 1 ? "" : "s"} — server.js ${(size / 1024).toFixed(1)}kb`);
  if (direct) console.log(`direct — the view leaves on console:ws://:${consolePort}, the hub keeps the tty`);
  for (const path of summary) console.log(`  ${path}`);
  if (bpfSize > 0) console.log(`bpf — bin/${OBJECT} ${(bpfSize / 1024).toFixed(1)}kb`);
  if (actions.size > 0 || isolateFns.size > 0) {
    console.log(`${actions.size} "use server" fn${actions.size === 1 ? "" : "s"} in node.js, ${isolateFns.size} "use yeet"`);
  }
  if (islands.size > 0) {
    console.log(`${islands.size} island${islands.size === 1 ? "" : "s"}, ${actions.size} action${actions.size === 1 ? "" : "s"} — islands.js ${(islandSize / 1024).toFixed(1)}kb`);
    for (const id of islands) console.log(`  ${id}`);
  }
}
