/* The dev loop.
 *
 * `yeet run --watch` cannot drive this: it refuses to respawn a run
 * whose tty is redirected, and this one's tty *is* the transport. So
 * the supervision happens here, and edits fall into two kinds that
 * need different answers:
 *
 *   isolate-side   anything the app bundle contains. Rebuild, then
 *                  restart the run. The page's socket drops, the
 *                  client reconnects on its own and asks for a fresh
 *                  tree — so a save costs one reconnect and no
 *                  reload.
 *   browser-side   index.html, client.js, the stylesheet. The page
 *                  itself has to be replaced, so connected browsers
 *                  are told to reload.
 *
 * Tailwind sits entirely on this side: it scans the app's sources on
 * the host and writes a stylesheet the dev server serves. The isolate
 * never sees CSS — it emits class names as ordinary attributes, and
 * they mean something because the browser already loaded the sheet.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, relative } from "node:path";

import { OBJECT, hasBpf, make, place } from "./bpf.mjs";
import { RUNTIME, createBundler, entryModule, islandsModule, nodeModule } from "./bundle.mjs";
import { createActions } from "../host/actions.mjs";
import { createHub, tapConsole } from "../host/bridge.mjs";
import { collectRoutes, patternOf, renderRouteModule } from "./routes.mjs";
import { findIcon, indexHtml } from "./html.mjs";
import { startTailwind } from "./tailwind.mjs";
import { sources, watchLoop } from "./watch.mjs";

const POLL_MS = 300;
/* The daemon tears the portal mount down after the run exits rather
 * than with it, so respawning too eagerly is met with "already
 * mounted". */
const RESPAWN_GRACE_MS = 900;
const STARTUP_GRACE_MS = 2500; // an exit sooner than this is a failed start
const START_RETRIES = 4;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const color = process.env.NO_COLOR === undefined && (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY);
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text) => paint("2", text);

const TAGS = {
  kit: paint("36", "yeetkit "),
  build: paint("32", "build   "),
  changed: paint("33", "changed "),
  restart: paint("35", "restart "),
  bpf: paint("34", "bpf     "),
  isolate: paint("2;37", "isolate "),
  error: paint("31", "error   "),
};

const log = (tag, message) => console.log(`${TAGS[tag]} ${dim("|")} ${message}`);

/* The verbs are real ones, not decoration. Every page is a GET because
 * routing lives in the isolate — a path returns the same shell and the
 * socket decides what to render, so there is no per-method page route
 * to list and a form submits over the socket rather than POSTing. The
 * other three are genuinely different transports, which is the useful
 * thing to see at a glance.
 */
const VERBS = {
  GET: "32",
  HEAD: "32",
  POST: "34",
  PUT: "34",
  PATCH: "34",
  DELETE: "31",
  OPTIONS: "2",
  WS: "36",
  SSE: "33",
  STREAM: "36",
  CALL: "35",
};

/* Both columns are sized from what is actually in the table rather
 * than from the longest verb that exists — a project with no `OPTIONS`
 * handler should not be paying for its seven characters.
 */
function routeTable(rows) {
  const verbWidth = Math.max(...rows.map(([verb]) => verb.length));
  const pathWidth = Math.max(...rows.map(([, path]) => path.length));

  return rows
    .map(([verb, path, note]) => {
      const painted = paint(VERBS[verb] ?? "0", verb + " ".repeat(verbWidth - verb.length));
      return `         ${painted}  ${path + " ".repeat(pathWidth - path.length)}  ${dim(note)}`;
    })
    .join("\n");
}

export async function dev(config) {
  const { root, appDir, publicDir, out, port, wsPort, title, model, direct, consolePort } = config;

  await mkdir(out, { recursive: true });

  // ---- browser reload channel ---------------------------------------

  const listeners = new Set();
  const reloadBrowsers = () => {
    for (const response of listeners) response.write("data: reload\n\n");
  };

  // ---- routes -------------------------------------------------------

  let routeSummary = [];
  let listening = false;

  /* Printed at startup and whenever the route set changes, which is
   * rare enough to be worth the whole table rather than a delta. */
  const printRoutes = () => {
    const rows = routeSummary.map((path) => ["GET", path, "page"]);
    rows.push(["WS", "/@yeetkit/ws", direct ? "browser \u2192 hub \u2192 isolate" : "hub \u2194 isolate"]);
    if (direct) rows.push(["WS", `ws://<host>:${consolePort}/`, "isolate \u2192 browser, direct"]);
    rows.push(["GET", "/@yeetkit/client.js", "browser client"]);
    rows.push(["GET", "/@yeetkit/styles.css", "tailwind"]);
    rows.push([
      "GET",
      "/@yeetkit/islands.js",
      islands.size > 0 ? `${islands.size} island${islands.size === 1 ? "" : "s"}` : "empty",
    ]);
    rows.push(["SSE", "/@yeetkit/reload", "dev only"]);

    /* Real methods, from what the module exports. */
    for (const route of actionRuntime.httpRoutes) {
      for (const method of route.methods) {
        rows.push([method, patternOf(route.segments), route.file]);
      }
    }

    /* Not HTTP, but reachable, and the thing people actually forget
     * the name of. The runtime is the point of the annotation. */
    for (const id of actions) rows.push(["CALL", id, "node"]);
    for (const id of isolateFns) {
      /* The generator exports were recorded with a trailing star, so
       * the table can show what pushes rather than replies. */
      const stream = id.endsWith("*");
      rows.push([stream ? "STREAM" : "CALL", stream ? id.slice(0, -1) : id, "isolate"]);
    }

    console.log(routeTable(rows));
  };

  const writeRoutes = async () => {
    const collected = await collectRoutes(appDir);
    const { code, summary } = renderRouteModule(collected, out);
    await writeFile(join(out, "routes.js"), code);
    /* Recorded rather than printed: the table below wants the port,
     * which is not bound yet the first time through. */
    const changed = summary.join() !== routeSummary.join();
    routeSummary = summary;
    if (changed && listening) printRoutes();
  };

  // ---- bpf ------------------------------------------------------------

  /* Compiled before the first bundle, because the bundle imports the
   * object it produces. A project with no bpf/ sources skips all of
   * this and never pays for the toolchain. */
  const buildBpf = async () => {
    if (!(await hasBpf(root))) return;

    const started = Date.now();
    const result = await make(root);

    if (!result.ok) {
      /* clang and the verifier both say useful things; passing them
       * through unedited is worth more than a summary. */
      log("error", "bpf build failed");
      for (const line of result.output.split("\n").slice(-12)) log("error", dim(line));
      return;
    }

    const size = await place(root, out);
    if (size !== null) {
      log("bpf", `${OBJECT} ${dim(`${(size / 1024).toFixed(1)}kb in ${Date.now() - started}ms`)}`);
    }
  };

  await buildBpf();
  await writeRoutes();
  const writeEntry = async () =>
    writeFile(join(out, "entry.jsx"), await entryModule({ title, appDir, out, direct }));
  await writeEntry();

  // ---- bundle -------------------------------------------------------

  const bundlePath = join(out, "server.js");
  let firstBuild = true;

  /* Filled in by the server pass and read by the client pass: the
   * server build is what discovers which modules are islands, so the
   * two passes run in that order, always. */
  const islands = new Set();
  const actions = new Set();
  const isolateFns = new Set();

  const bundler = await createBundler({
    entry: join(out, "entry.jsx"),
    outfile: bundlePath,
    dev: true,
    root,
    appDir,
    side: "server",
    islands,
    actions,
    isolateFns,
    onRebuild(result) {
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          const at = error.location ? `${relative(root, error.location.file)}:${error.location.line}` : "";
          log("error", `${error.text} ${dim(at)}`);
        }
        return;
      }
      if (firstBuild) firstBuild = false;
      else restartIsolate();
    },
  });

  /* The island bundle is rebuilt from scratch each time rather than
   * kept as a context: its entry module changes whenever a `"use
   * client"` is added or removed, and esbuild contexts are pinned to
   * one entry. It is small, and it only runs when the app has islands. */
  let islandBundler = null;
  let nodeBundler = null;

  const actionRuntime = createActions({ log });
  actionRuntime.install();

  /* The host's own bundle. Rebuilt and re-imported on change, which is
   * how a `"use server"` edit takes effect without restarting the
   * process holding the sockets. */
  const rebuildNode = async () => {
    const entry = join(out, "node-entry.js");
    await writeFile(entry, await nodeModule({ appDir, root, out }));

    await nodeBundler?.dispose();
    nodeBundler = await createBundler({
      entry,
      outfile: join(out, "node.js"),
      dev: true,
      root,
      appDir,
      side: "node",
      islands,
      actions,
      isolateFns,
      onRebuild(result) {
        for (const error of result.errors ?? []) log("error", `host: ${error.text}`);
      },
    });
    await nodeBundler.rebuild().catch(() => {});
    await actionRuntime.load(join(out, "node.js"));
  };

  const rebuildIslands = async () => {
    const entry = join(out, "islands.jsx");
    await writeFile(entry, islandsModule(islands, { root, out }));

    await islandBundler?.dispose();
    islandBundler = await createBundler({
      entry,
      outfile: join(out, "islands.js"),
      dev: true,
      root,
      appDir,
      side: "client",
      islands,
      actions,
      isolateFns,
      onRebuild(result) {
        for (const error of result.errors ?? []) {
          const at = error.location ? `${relative(root, error.location.file)}:${error.location.line}` : "";
          log("error", `island: ${error.text} ${dim(at)}`);
          for (const note of error.notes ?? []) log("error", dim(`  ${note.text}`));
        }
      },
    });
    await islandBundler.rebuild().catch(() => {});
  };

  const rebuild = async () => {
    try {
      await bundler.rebuild();
    } catch {
      // Errors are already reported by onRebuild.
    }
    /* Always after the server pass, which is what populates the sets. */
    await rebuildNode();
    await rebuildIslands();
    if (islands.size > 0 || actions.size > 0) reloadBrowsers();
  };

  await rebuild();

  // ---- tailwind -----------------------------------------------------

  const tailwind = await startTailwind({ root, appDir, out, watch: true, onBuild: reloadBrowsers, log });

  // ---- the isolate --------------------------------------------------

  let child = null;
  let restarting = false;

  const startIsolate = (attempt = 0) => {
    const startedAt = Date.now();
    /* Loopback, not 0.0.0.0: the browser does not talk to the tty lane,
     * the hub does, and it is in this process. In direct mode the
     * console lane is the one browsers dial, so it binds wide. */
    const argv = ["run", "-p", `tty:ws://127.0.0.1:${wsPort}`];
    if (direct) argv.push("-p", `console:ws://0.0.0.0:${consolePort}`);
    argv.push(bundlePath);
    if (model) argv.push("--", "--model", model);

    child = spawn("yeet", argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

    const relay = (stream) =>
      stream.on("data", (chunk) => {
        for (const line of String(chunk).split("\n").filter(Boolean)) log("isolate", dim(line));
      });
    relay(child.stdout);
    relay(child.stderr);

    const spawned = child;
    child.on("exit", (code) => {
      if (spawned !== child || restarting) return;
      /* An exit inside the startup grace is a failed start, usually
       * the previous mount not yet released — worth retrying. A later
       * exit is the app itself ending, and is left alone. */
      if (Date.now() - startedAt < STARTUP_GRACE_MS && attempt < START_RETRIES) {
        setTimeout(() => startIsolate(attempt + 1), RESPAWN_GRACE_MS);
      } else if (code !== 0) {
        log("error", `isolate exited (${code})`);
      }
    });
  };

  const restartIsolate = () => {
    if (restarting) return;
    restarting = true;
    log("restart", dim("isolate"));
    const dying = child;
    child = null;
    dying?.kill("SIGTERM");
    setTimeout(() => {
      restarting = false;
      startIsolate();
    }, RESPAWN_GRACE_MS);
  };

  startIsolate();

  /* With the console lane on a socket, the app's own `console.log` no
   * longer reaches stdout above; this fetches it back, minus the view. */
  const consoleTap = direct
    ? tapConsole({ url: `ws://127.0.0.1:${consolePort}/`, onLine: (line) => log("isolate", dim(line)) })
    : null;

  // ---- watching -----------------------------------------------------

  const isBrowserSide = (file) =>
    basename(file) === "client.js" || file.endsWith(".html") || file.endsWith(".css");

  watchLoop({
    list: () => sources([appDir, join(root, "src"), join(root, "lib"), join(root, "bpf"), RUNTIME], publicDir),
    interval: POLL_MS,
    async onChange(changed) {
      for (const file of changed) log("changed", dim(relative(root, file)));

      /* A kernel-side edit recompiles and then restarts, because the
       * object is loaded when the isolate starts, not when the page
       * asks for it. */
      if (changed.some((file) => /\.(bpf\.c|h)$/.test(file))) {
        await buildBpf();
        restartIsolate();
        return;
      }

      /* A file appearing or vanishing under `app/` can add or remove a
       * route, so the table is regenerated before the rebuild that
       * will import it. */
      if (changed.some((file) => file.startsWith(appDir))) {
        await writeRoutes();
        /* A new `"use server"` module has to be imported by the entry
         * before the rebuild that would otherwise never see it. */
        await writeEntry();
      }

      /* The theme lives in the user's file; Tailwind watches a generated
       * copy of it. */
      if (changed.some((file) => file === join(appDir, "globals.css"))) await tailwind?.regenerate();

      if (changed.every(isBrowserSide)) reloadBrowsers();
      else await rebuild();
    },
  });

  // ---- http ---------------------------------------------------------

  const clientJs = join(RUNTIME, "..", "client", "client.js");
  const html = indexHtml({ title, dev: true, direct: direct ? consolePort : null, icon: await findIcon(publicDir) });

  /* Node's http server speaks streams; a route handler speaks
   * `Request`/`Response`. Translating here rather than in the handler
   * is what keeps a handler portable — it could be lifted into any
   * other runtime unchanged.
   */
  const serveApi = async (request, response, url) => {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await new Promise((resolve) => {
            const chunks = [];
            request.on("data", (chunk) => chunks.push(chunk));
            request.on("end", () => resolve(Buffer.concat(chunks)));
          });

    const result = await actionRuntime.dispatch(
      new Request(url, { method: request.method, headers: request.headers, body }),
    );
    if (!result) return false;

    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
    log(result.status >= 400 ? "error" : "kit", dim(`${request.method} ${url.pathname} ${result.status}`));
    return true;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const path = decodeURIComponent(url.pathname);

    /* `app/**​/route.js` first: these are the only paths that are not
     * the page shell, and a handler must win over the fallback that
     * answers everything else. */
    if (!path.startsWith("/@yeetkit/")) {
      const answered = await serveApi(request, response, url);
      if (answered) return;
    }

    if (path === "/@yeetkit/reload") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write("retry: 500\n\n");
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
      return;
    }

    const serve = async (file, type) => {
      try {
        const body = await readFile(file);
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(body);
        return true;
      } catch {
        return false;
      }
    };

    /* Every branch below must end in a response. A route that returns
     * without writing one leaves the browser waiting forever — and
     * because the stylesheet is render-blocking, a missing file there
     * is not a missing style, it is a page that never paints. That is
     * why the stylesheet answers with empty CSS rather than a 404:
     * broken styling is worth seeing, a hung page is not.
     */
    if (path === "/@yeetkit/client.js") {
      if (!(await serve(clientJs, TYPES[".js"]))) {
        response.writeHead(500, { "content-type": TYPES[".js"] });
        response.end(`console.error("yeetkit: client.js is missing");`);
      }
      return;
    }

    if (path === "/@yeetkit/islands.js") {
      if (!(await serve(join(out, "islands.js"), TYPES[".js"]))) {
        /* An app with no islands still has to get a module back — the
         * client imports it unconditionally. */
        response.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
        response.end("export const empty = true;\n");
      }
      return;
    }

    if (path === "/@yeetkit/styles.css") {
      if (!(await serve(join(out, "styles.css"), TYPES[".css"]))) {
        response.writeHead(200, { "content-type": TYPES[".css"], "cache-control": "no-store" });
        response.end("/* yeetkit: no stylesheet yet */\n");
      }
      return;
    }

    /* A static file if there is one, and the app shell otherwise:
     * routing lives in the isolate, so every unclaimed path has to
     * reach the page rather than 404. */
    if (path !== "/") {
      const asset = join(publicDir, normalize(path).replace(/^(\.\.[/\\])+/, ""));
      if (asset.startsWith(publicDir) && (await stat(asset).catch(() => null))?.isFile()) {
        if (await serve(asset, TYPES[extname(asset)] ?? "application/octet-stream")) return;
      }
    }

    response.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
    response.end(html);
  });

  /* The hub attaches to the same HTTP server the page came from, so a
   * browser needs one origin and no second port. */
  const hub = createHub({
    isolateUrl: `ws://127.0.0.1:${wsPort}/`,
    server,
    actions: actionRuntime,
    log: () => {},
  });
  actionRuntime.useIsolate(hub.callIsolate);

  server.listen(port, () => {
    listening = true;
    log("kit", paint("1", `http://localhost:${port}`));
    printRoutes();
  });

  const shutdown = () => {
    restarting = true;
    child?.kill("SIGTERM");
    tailwind?.stop();
    hub?.close();
    consoleTap?.close();
    bundler.dispose();
    islandBundler?.dispose();
    nodeBundler?.dispose();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
