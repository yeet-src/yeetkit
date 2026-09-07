#!/usr/bin/env node
/* The hub, and the three runtimes it joins.
 *
 *   browser <-ws-> node <-ws-> isolate
 *
 * What is worth asserting here is not that each runtime works — the
 * other phases do that — but that the *seams* do: that a browser
 * reaches the view without ever touching the isolate's portal, that a
 * `"use server"` call is answered by Node, and that Node can turn
 * around and ask the isolate something in the middle of it.
 *
 * The last one is the whole reason this topology exists, so it is
 * checked by asserting on a value only the isolate can produce.
 *
 *   node src/cli/checkhub.mjs <project-dir> [--port 3610]
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(process.argv[2] ?? ".");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? Number(process.argv[at + 1]) : 3610;
const wsPort = port + 1;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";

const encode = (message) => {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  let out = "";
  let bits = 0;
  let width = 0;
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    width += 8;
    while (width >= 6) {
      width -= 6;
      out += B64[(bits >> width) & 0x3f];
    }
  }
  if (width > 0) out += B64[(bits << (6 - width)) & 0x3f];
  return new TextEncoder().encode(`${out}\n`);
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? ` \u2014 ${detail}` : ""}`);
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

const ready = await (async () => {
  for (let i = 0; i < 250; i += 1) {
    if (log.includes(`http://localhost:${port}`)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})();

console.log("\nhub");
check("the dev server starts", ready, log.slice(-200));

if (!ready) {
  console.log(`\n1 failed\n`);
  await stop();
  process.exit(1);
}

/* Give the isolate a moment to come up and the hub to attach to it. */
await new Promise((r) => setTimeout(r, 2500));

const socket = new WebSocket(`ws://127.0.0.1:${port}/@yeetkit/ws`);
socket.binaryType = "arraybuffer";

const frames = [];
let pending = "";
socket.addEventListener("message", (event) => {
  pending += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
  for (;;) {
    const start = pending.indexOf(OSC_OPEN);
    if (start < 0) return;
    const end = pending.indexOf(OSC_CLOSE, start);
    if (end < 0) return;
    try {
      frames.push(JSON.parse(pending.slice(start + OSC_OPEN.length, end)));
    } catch {
      // torn frame
    }
    pending = pending.slice(end + OSC_CLOSE.length);
  }
});

const connected = await new Promise((done) => {
  socket.addEventListener("open", () => done(true));
  socket.addEventListener("error", () => done(false));
  setTimeout(() => done(false), 8000);
});

check("a browser connects to node, not the isolate", connected);

const drain = async (ms) => {
  await new Promise((r) => setTimeout(r, ms));
  return frames.splice(0, frames.length).flatMap((f) => (f.op === "batch" ? f.patches : [f]));
};

const textOf = (node) => (!node ? "" : (node.text ?? "") + (node.kids ?? []).map(textOf).join(""));

if (connected) {
  socket.send(encode({ t: "hello", path: "/" }));
  let got = await drain(2000);
  const mount = got.find((f) => f.op === "mount");
  check("the view is relayed through the hub", Boolean(mount));
  check("it is the real tree", textOf(mount?.root).length > 50);

  /* The one that matters: Node runs this, and it calls the isolate
   * partway through. A process count can only have come from there. */
  socket.send(encode({ t: "nodecall", cid: 1, action: "app/lib/server.js#snapshot", args: [] }));
  got = await drain(4000);
  const reply = got.find((f) => f.op === "noderesult" && f.cid === 1);

  check('"use server" is answered by node', Boolean(reply), "no reply");
  check("node builtins are available there", Boolean(reply?.value?.node), reply?.error ?? "");
  check("it read a file with fs", reply?.value?.project && reply.value.project !== "unknown", String(reply?.value?.project));
  check(
    "node reached the isolate mid-call",
    Number(reply?.value?.processes) > 0,
    "the graph reading never came back",
  );

  /* And the isolate is still reachable directly, through the same hub. */
  socket.send(encode({ t: "call", cid: 2, action: "app/lib/host.js#processCount", args: [] }));
  got = await drain(2500);
  const isolate = got.find((f) => f.op === "return" && f.cid === 2);
  check('"use yeet" still routes to the isolate', typeof isolate?.value === "number", isolate?.error ?? "");

  /* A STREAM, and the two things that make it more than a call: values
   * arrive without being asked for, and they arrive only for the reader
   * that asked. The second browser below uses the *same* id on purpose —
   * each browser counts from 1, so without the hub rewriting them two
   * tabs would collide. */
  const other = new WebSocket(`ws://127.0.0.1:${port}/@yeetkit/ws`);
  other.binaryType = "arraybuffer";
  const otherFrames = [];
  let otherBuf = "";
  other.addEventListener("message", (event) => {
    otherBuf += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    for (;;) {
      const start = otherBuf.indexOf(OSC_OPEN);
      if (start < 0) return;
      const end = otherBuf.indexOf(OSC_CLOSE, start);
      if (end < 0) return;
      try {
        otherFrames.push(JSON.parse(otherBuf.slice(start + OSC_OPEN.length, end)));
      } catch {
        // torn
      }
      otherBuf = otherBuf.slice(end + OSC_CLOSE.length);
    }
  });
  await new Promise((done) => {
    other.addEventListener("open", () => done(true));
    setTimeout(() => done(false), 5000);
  });

  socket.send(encode({ t: "stream", sid: 1, action: "app/lib/exec.js#tail", args: [] }));
  await drain(700);
  otherFrames.length = 0;

  /* Something to stream. An exec is the cheapest event this program
   * sees, and running one is how the assertion gets a value at all. */
  const { spawn: run } = await import("node:child_process");
  for (let i = 0; i < 3; i += 1) run("/bin/echo", ["yeetkit"]);

  got = await drain(1800);
  const yields = got.filter((f) => f.op === "yield" && f.value);

  check("a STREAM pushes values without being polled", yields.length > 0, `${yields.length} values`);
  check("the reader gets back the id it chose", yields.every((f) => f.sid === 1), JSON.stringify(yields[0]?.sid));
  check(
    "a stream reaches only the browser that opened it",
    otherFrames.filter((f) => f.op === "yield").length === 0,
    "another tab received someone else's stream",
  );

  /* Cancelling has to reach the producer, or a closed tab leaves a
   * generator running for the life of the isolate. */
  socket.send(encode({ t: "unstream", sid: 1 }));
  await drain(500);
  for (let i = 0; i < 3; i += 1) run("/bin/echo", ["yeetkit"]);
  got = await drain(1500);
  check(
    "cancelling a stream stops it",
    got.filter((f) => f.op === "yield").length === 0,
    "values kept arriving after unstream",
  );
  other.close();

  /* A nodecall must never be relayed onward: its arguments are the
   * thing this topology exists to keep off the broadcast. */
  check(
    "node traffic is not echoed to browsers",
    !got.some((f) => f.op === "nodecall") && !got.some((f) => f.t === "noderesult"),
  );
}

console.log(`\n${failures === 0 ? "hub ok" : `${failures} failed`}\n`);
socket.close();
await stop();
process.exit(failures === 0 ? 0 : 1);
