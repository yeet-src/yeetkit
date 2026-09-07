/* Turns the `app/` directory into a route table.
 *
 * The conventions are Next's, minus the ones that only make sense
 * when every navigation is a request:
 *
 *   app/page.jsx                 ->  /
 *   app/about/page.jsx           ->  /about
 *   app/users/[id]/page.jsx      ->  /users/:id
 *   app/docs/[...path]/page.jsx  ->  /docs/*
 *   app/layout.jsx               ->  wraps everything below it
 *   app/(group)/page.jsx         ->  /          (parens organise, not route)
 *   app/not-found.jsx            ->  the fallback
 *
 * The output is a module, not data: routes hold real component
 * references, so the bundler follows them and an unreachable page is
 * simply never bundled.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { exportsOf } from "./directives.mjs";

const PAGE = /^page\.(jsx|js|tsx|ts)$/;
const ROUTE = /^route\.(js|ts)$/;
const LAYOUT = /^layout\.(jsx|js|tsx|ts)$/;
const NOT_FOUND = /^not-found\.(jsx|js|tsx|ts)$/;

const isGroup = (name) => name.startsWith("(") && name.endsWith(")");

function segmentOf(name) {
  if (name.startsWith("[...") && name.endsWith("]")) {
    return { kind: "rest", name: name.slice(4, -1) };
  }
  if (name.startsWith("[") && name.endsWith("]")) {
    return { kind: "param", name: name.slice(1, -1) };
  }
  return { kind: "static", name };
}

/** Walks `app/`, collecting one route per `page.*` with its layout chain. */
export async function collectRoutes(appDir) {
  const routes = [];
  let notFound = null;

  const walk = async (dir, segments, layouts) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const layout = files.find((name) => LAYOUT.test(name));
    const chain = layout ? [...layouts, join(dir, layout)] : layouts;

    const missing = files.find((name) => NOT_FOUND.test(name));
    /* The layout chain comes with it, so a not-found page renders
     * inside the same shell every other page does. */
    if (missing && notFound === null) notFound = { page: join(dir, missing), layouts: chain };

    const page = files.find((name) => PAGE.test(name));
    if (page) routes.push({ segments, layouts: chain, page: join(dir, page) });

    for (const entry of entries.filter((e) => e.isDirectory())) {
      if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
      await walk(
        join(dir, entry.name),
        isGroup(entry.name) ? segments : [...segments, segmentOf(entry.name)],
        chain,
      );
    }
  };

  await walk(appDir, [], []);
  return { routes, notFound };
}

const pathOf = (segments) =>
  "/" +
  segments
    .map((s) => (s.kind === "static" ? s.name : s.kind === "param" ? `:${s.name}` : `*${s.name}`))
    .join("/");

export function renderRouteModule({ routes, notFound }, root) {
  const spec = (file) => `./${relative(root, file).replaceAll("\\", "/")}`;
  const lines = [];
  const imports = new Map();

  const importOf = (file) => {
    if (!imports.has(file)) imports.set(file, `_r${imports.size}`);
    return imports.get(file);
  };

  const entries = routes.map((route) => {
    const layouts = route.layouts.map(importOf);
    const page = importOf(route.page);
    return `  { segments: ${JSON.stringify(route.segments)}, layouts: [${layouts.join(", ")}], page: ${page} },`;
  });

  const fallback = notFound
    ? `{ layouts: [${notFound.layouts.map(importOf).join(", ")}], page: ${importOf(notFound.page)} }`
    : "null";

  /* Emitted last, so every `importOf` above has already claimed its
   * name. */
  for (const [file, name] of imports) {
    lines.push(`import ${name} from "${spec(file)}";`);
  }

  lines.push("");
  lines.push("export const routes = [");
  lines.push(...entries);
  lines.push("];");
  lines.push("");
  lines.push(`export const notFound = ${fallback};`);

  return {
    code: lines.join("\n") + "\n",
    summary: routes.map((r) => pathOf(r.segments)).sort(),
  };
}

/* HTTP methods a `route.js` may export. Anything else it exports is
 * left alone — a helper next to the handlers is normal.
 */
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/* `app/**​/route.js` — the one part of an app that answers HTTP
 * directly.
 *
 * Everything else here is rendered over a socket, so these exist for
 * the callers a socket cannot serve: a webhook from a service that has
 * never heard of this framework, a `curl`, an upload. They run in Node,
 * because that is what holds the listener and what has the `crypto` a
 * signature check needs — and they can import a `"use yeet"` function
 * when they want something only the isolate can answer.
 */
export async function collectApiRoutes(appDir) {
  const found = [];

  const walk = async (dir, segments) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const file = entries.filter((e) => e.isFile()).find((e) => ROUTE.test(e.name));
    if (file) {
      const path = join(dir, file.name);
      const exported = await exportsOf(await readFile(path, "utf8"), path);
      const methods = METHODS.filter((method) => exported.includes(method));
      if (methods.length > 0) found.push({ segments, file: path, methods });
    }

    for (const entry of entries.filter((e) => e.isDirectory())) {
      if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
      await walk(dir === appDir ? join(dir, entry.name) : join(dir, entry.name),
        isGroup(entry.name) ? segments : [...segments, segmentOf(entry.name)]);
    }
  };

  await walk(appDir, []);
  return found;
}

export const patternOf = (segments) =>
  "/" +
  segments
    .map((s) => (s.kind === "static" ? s.name : s.kind === "param" ? `:${s.name}` : `*${s.name}`))
    .join("/");
