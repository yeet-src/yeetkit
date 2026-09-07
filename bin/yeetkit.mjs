#!/usr/bin/env node
/* yeetkit — SolidJS apps that run inside a yeet isolate.
 *
 *   yeetkit dev            the app, rebuilding and restarting on change
 *   yeetkit build          a production bundle in dist/
 *   yeetkit start          serve a build, supervising the isolate
 *   yeetkit check          drive a built app over a real portal
 *   yeetkit new <name>     a project to start from
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] ?? "dev";

const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};

async function loadConfig(root) {
  const defaults = {
    root,
    appDir: join(root, "app"),
    publicDir: join(root, "public"),
    out: join(root, ".yeetkit"),
    dist: join(root, "dist"),
    port: 3000,
    wsPort: 3001,
    title: "yeetkit",
    model: null,
    /* Direct mode: the isolate's console lane is bound to a second
     * WebSocket that browsers dial themselves, and carries the view.
     * The hub keeps the tty for events and everything private. */
    direct: false,
    consolePort: null, // wsPort + 1 unless set
  };

  /* A config file is optional — the conventions above are the whole
   * story for most projects — and a flag on the command line wins
   * over it, so a second instance is `--port 3100 --ws 3101`.
   */
  let loaded = {};
  const file = join(root, "yeetkit.config.js");
  try {
    loaded = (await import(`file://${file}`)).default ?? {};
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  const overrides = {};
  if (loaded.ws !== undefined) overrides.wsPort = Number(loaded.ws);
  if (loaded.console !== undefined) overrides.consolePort = Number(loaded.console);
  if (flag("port")) overrides.port = Number(flag("port"));
  if (flag("ws")) overrides.wsPort = Number(flag("ws"));
  if (flag("console")) overrides.consolePort = Number(flag("console"));
  if (flag("model")) overrides.model = flag("model");
  /* Boolean flags take no value, so they are looked up by presence. */
  if (argv.includes("--direct")) overrides.direct = true;
  if (argv.includes("--no-direct")) overrides.direct = false;

  const config = { ...defaults, ...loaded, ...overrides, root };
  for (const key of ["appDir", "publicDir", "out", "dist"]) {
    config[key] = resolve(root, config[key]);
  }
  config.direct = Boolean(config.direct);
  if (config.consolePort === null || Number.isNaN(config.consolePort)) config.consolePort = config.wsPort + 1;
  return config;
}

const root = resolve(flag("dir", process.cwd()));

switch (command) {
  case "dev": {
    const { dev } = await import("../src/cli/dev.mjs");
    await dev(await loadConfig(root));
    break;
  }

  case "build": {
    const { build } = await import("../src/cli/build.mjs");
    await build(await loadConfig(root));
    break;
  }

  case "start": {
    const config = await loadConfig(root);
    await start(config);
    break;
  }

  /* The wire, end to end: a real isolate, a real portal, the protocol
   * the browser speaks. Runs against `dist/`, so `build` first. */
  case "check": {
    const config = await loadConfig(root);
    const { spawn: run } = await import("node:child_process");
    const wire = join(here, "..", "src", "cli", "check.mjs");
    const devside = join(here, "..", "src", "cli", "checkdev.mjs");
    const islandside = join(here, "..", "src", "cli", "checkislands.mjs");
    const hubside = join(here, "..", "src", "cli", "checkhub.mjs");

    const phase = (script, argv) =>
      new Promise((done) => {
        run(process.execPath, [script, ...argv], { stdio: "inherit" }).on("exit", (code) => done(code ?? 1));
      });

    /* The wire and the dev server fail in different ways and neither
     * covers the other: one asserts the patches, the other asserts
     * that every route actually answers. */
    /* The wire check follows the build's mode: a direct build puts the
     * view on the console lane and the check has to listen there. The
     * dev and hub checks assert the hub topology, so they pin it. */
    const wireCode = await phase(wire, [
      config.dist,
      "--ws",
      String(config.wsPort + 90),
      ...(config.direct ? ["--console", String(config.consolePort + 90)] : []),
    ]);
    const devCode = await phase(devside, [
      config.root,
      "--port",
      String(config.port + 410),
      "--ws",
      String(config.wsPort + 410),
    ]);
    const islandCode = await phase(islandside, [config.root]);
    const hubCode = await phase(hubside, [config.root, "--port", String(config.port + 610)]);
    process.exit(wireCode || devCode || islandCode || hubCode);
  }

  case "new": {
    const name = argv[1];
    if (!name) {
      console.error("usage: yeetkit new <name>");
      process.exit(1);
    }
    const target = resolve(root, name);
    await mkdir(target, { recursive: true });
    await cp(join(here, "..", "templates", "default"), target, { recursive: true });

    /* The manifest is generated rather than copied so the dependency
     * can name wherever this framework actually came from.
     *
     * Installed from a registry, that is its version. Run from a
     * checkout — which is the case until yeetkit is published — it is
     * a `file:` path, and that is what puts `yeetkit` on the
     * generated project's own PATH so `npm run dev` works with no
     * global install. Being inside a `node_modules` is what
     * distinguishes the two, and it is also what keeps a published
     * copy from baking one machine's paths into every project it
     * scaffolds.
     */
    const framework = resolve(here, "..");
    const installed = framework.split(sep).includes("node_modules");
    const { version } = JSON.parse(await readFile(join(framework, "package.json"), "utf8"));
    const dependency = installed ? `^${version}` : `file:${framework}`;
    await writeFile(
      join(target, "package.json"),
      `${JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: {
            dev: "yeetkit dev",
            build: "yeetkit build",
            start: "yeetkit start",
            check: "yeetkit build && yeetkit check",
          },
          dependencies: { yeetkit: dependency },
        },
        null,
        2,
      )}\n`,
    );

    console.log(`created ${name}\n\n  cd ${name}\n  npm install\n  npm run dev\n`);
    break;
  }

  default:
    console.error(`unknown command: ${command}\n\n  yeetkit dev | build | start | check | new <name>`);
    process.exit(1);
}

/* Serving a build is the dev loop with the compilers taken out: the
 * same hub, the same host runtime, the same three doors a browser can
 * knock on — minus the bundler, the watcher and the Tailwind process.
 *
 * It has to be the same, or production would be missing the parts of
 * the app that are not the page: `"use server"` functions, the island
 * RPC, and `app/**​/route.js`.
 */
async function start({ dist, port, wsPort, direct, consolePort, root: cwd }) {
  const { createActions } = await import("../src/host/actions.mjs");
  const { createHub, tapConsole } = await import("../src/host/bridge.mjs");

  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };

  const log = (tag, message) => console.error(`${tag}: ${message}`);

  const actions = createActions({ log });
  actions.install();
  await actions.load(join(dist, "node.js"));

  /* Loopback: the browser talks to this process, and this process is
   * the only peer on the isolate's tty. In direct mode the console lane
   * is bound wide as well, and that is the one browsers dial. */
  const lanes = ["-p", `tty:ws://127.0.0.1:${wsPort}`];
  if (direct) lanes.push("-p", `console:ws://0.0.0.0:${consolePort}`);
  const spawnIsolate = () => {
    const child = spawn("yeet", ["run", ...lanes, join(dist, "server.js")], {
      cwd,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      console.error(`isolate exited (${code}) — restarting`);
      setTimeout(spawnIsolate, 1000);
    });
    return child;
  };
  const child = spawnIsolate();
  const consoleTap = direct
    ? tapConsole({ url: `ws://127.0.0.1:${consolePort}/`, onLine: (line) => log("isolate", line) })
    : null;

  const readBody = (request) =>
    request.method === "GET" || request.method === "HEAD"
      ? Promise.resolve(undefined)
      : new Promise((resolve) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => resolve(Buffer.concat(chunks)));
        });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const path = decodeURIComponent(url.pathname);

    /* `app/**​/route.js`, before the static files and the shell. */
    if (!path.startsWith("/@yeetkit/")) {
      const answer = await actions.dispatch(
        new Request(url, { method: request.method, headers: request.headers, body: await readBody(request) }),
      );
      if (answer) {
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
    }

    const asset = join(dist, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    const file = asset.startsWith(dist) ? asset : null;
    const body = file && (await readFile(file).catch(() => null));

    if (body) {
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
      return;
    }

    /* Routing lives in the isolate, so an unclaimed path is a route,
     * not a miss — the shell is served and the socket decides. */
    response.writeHead(200, { "content-type": TYPES[".html"] });
    response.end(await readFile(join(dist, "index.html")));
  });

  const hub = createHub({
    isolateUrl: `ws://127.0.0.1:${wsPort}/`,
    server,
    actions,
    log: () => {},
  });
  actions.useIsolate(hub.callIsolate);

  server.listen(port, () =>
    console.log(`yeetkit — http://localhost:${port}${direct ? ` (view direct from ws://<host>:${consolePort})` : ""}`),
  );

  process.on("SIGINT", () => {
    hub.close();
    consoleTap?.close();
    child.kill("SIGTERM");
    process.exit(0);
  });
}
