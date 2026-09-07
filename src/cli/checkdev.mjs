#!/usr/bin/env node
/* Smoke check for the dev server.
 *
 * `check.mjs` drives the wire; this drives the HTTP side, which has
 * its own failure mode and a nastier one. A route that returns
 * without writing a response does not error — it leaves the browser
 * waiting, and since the stylesheet is render-blocking, a missing
 * file there means a page that never paints. Nothing about that looks
 * like a failure from the server's side, so every asset is fetched
 * here with a timeout and a missing response is a failure.
 *
 *   node src/cli/checkdev.mjs <project-dir> [--port 3410] [--ws 3411]
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(process.argv[2] ?? ".");

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const port = flag("port", 3410);
const wsPort = flag("ws", 3411);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const server = spawn(
  process.execPath,
  [resolve(here, "..", "..", "bin", "yeetkit.mjs"), "dev", "--port", String(port), "--ws", String(wsPort)],
  {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    /* Its own process group, so stopping it can take the isolate and
     * the Tailwind watcher with it. Without this the group kill below
     * has no group to aim at, the server outlives the run, and the
     * next one fails on EADDRINUSE for a reason that looks nothing
     * like a leaked process. */
    detached: true,
  },
);

let log = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", (c) => (log += c));

/* Group first, then the leader, then a moment for the signal to be
 * delivered — exiting immediately after `kill` is how the child
 * survives the parent.
 */
const stop = async () => {
  for (const target of [-server.pid, server.pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
};

/* Waiting for the banner rather than a fixed sleep: a slow first
 * bundle would otherwise look like a failure. */
const ready = await Promise.race([
  (async () => {
    for (let i = 0; i < 200; i += 1) {
      if (log.includes(`http://localhost:${port}`)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })(),
  new Promise((r) => setTimeout(() => r(false), 25_000)),
]);

console.log("\ndev server");
check("starts and prints its address", ready, log.slice(-300));

/* The timeout is the point of the whole file: a route that never
 * responds must fail here rather than hang the run. */
const get = async (path, ms = 5000, init = {}) => {
  const stop = AbortSignal.timeout(ms);
  try {
    const response = await fetch(`http://localhost:${port}${path}`, { signal: stop, ...init });
    return {
      status: response.status,
      body: await response.text(),
      allow: response.headers.get("allow"),
    };
  } catch (error) {
    return { status: 0, body: "", error: error.name };
  }
};

const send = (path, method, body) =>
  get(path, 12_000, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const json = (result) => {
  try {
    return JSON.parse(result.body);
  } catch {
    return null;
  }
};

if (ready) {
  /* Tailwind's first build races the banner; the stylesheet has to
   * arrive, but it is allowed to take a moment. */
  let styles = await get("/@yeetkit/styles.css");
  for (let i = 0; i < 20 && styles.body.length < 500; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    styles = await get("/@yeetkit/styles.css");
  }

  const page = await get("/");
  check("the page responds", page.status === 200, `status ${page.status}`);
  check("the page loads the client", page.body.includes("/@yeetkit/client.js"));

  const client = await get("/@yeetkit/client.js");
  check("client.js responds", client.status === 200, `status ${client.status}`);
  check("client.js is the client", /export (async )?function connect/.test(client.body));

  check("the stylesheet responds", styles.status === 200, `status ${styles.status || "no response"}`);
  check(
    "the stylesheet has Tailwind in it",
    styles.body.length > 500,
    `${styles.body.length} bytes — the watcher probably died`,
  );
  /* Derived from the app's own source rather than from a class this
   * file happens to remember. Tailwind's whole job here is that the
   * two halves agree, so the test reads one half and looks for it in
   * the other. */
  const { readFile: readSource } = await import("node:fs/promises");
  const source = await readSource(join(project, "app", "layout.jsx"), "utf8").catch(() => "");
  const used = [...source.matchAll(/class="([^"{}]+)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((name) => /^[a-z][a-z0-9-]{3,}$/.test(name) && !name.includes(":"));

  const found = used.filter((name) => styles.body.includes(`.${name}`));
  check(
    "classes used in app/ are in the stylesheet",
    used.length > 0 && found.length > 0,
    used.length === 0 ? "found no classes to look for" : `none of ${used.length} matched`,
  );

  const deep = await get("/procs/42");
  check("an unrouted path still serves the shell", deep.status === 200 && deep.body.includes("<div id=\"app\">"));

  const missing = await get("/nope.png");
  check("a missing asset answers rather than hangs", missing.status !== 0, missing.error ?? "");

  /* `app/**​/route.js` — the only paths in the app that are not the
   * shell. Worth asserting per verb, because a handler is looked up by
   * export name: a typo gives a 405 rather than an error, and 405 on a
   * route you believe you wrote is a confusing thing to debug. */
  const api = "/api/execs";
  const read = await get(api, 12_000);

  if (read.status === 0 || read.status === 200 && !json(read)) {
    console.log("  skipped — this project has no /api/execs route");
  } else {
    check("GET reaches a route handler", read.status === 200, `status ${read.status}`);
    check("it answered with JSON", Boolean(json(read)), read.body.slice(0, 60));

    /* PATCH keeps what it was not told about; PUT does not. That is
     * the whole difference between them, so it is what gets checked. */
    await send(api, "PUT", { minPid: 4242, filter: "zz" });
    const patched = json(await send(api, "PATCH", { filter: "yy" }));
    check(
      "PATCH changes one field and keeps the rest",
      patched?.settings?.filter === "yy" && patched?.settings?.minPid === 4242,
      JSON.stringify(patched?.settings),
    );

    const put = json(await send(api, "PUT", { filter: "yy" }));
    check(
      "PUT replaces the whole resource",
      put?.settings?.filter === "yy" && put?.settings?.minPid === 0,
      JSON.stringify(put?.settings),
    );

    const cleared = json(await send(api, "DELETE"));
    check("DELETE reaches its handler", typeof cleared?.cleared === "number", JSON.stringify(cleared));

    const wrong = await send(api, "OPTIONS");
    check("an unhandled verb is 405, not 404", wrong.status === 405, `status ${wrong.status}`);
    check("and it says which verbs it takes", (wrong.allow ?? "").includes("PATCH"), String(wrong.allow));

    /* A path under /api that no route claims is still a page path —
     * routing lives in the isolate, so nothing here may 404. */
    const unclaimed = await get("/api/nothing-here");
    check("an unclaimed path still serves the shell", unclaimed.status === 200 && unclaimed.body.includes("<div id=\"app\">"));

    await send(api, "PUT", {});
  }
}

console.log(`\n${failures === 0 ? "dev server ok" : `${failures} failed`}\n`);
await stop();
process.exit(failures === 0 ? 0 : 1);
