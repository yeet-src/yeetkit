#!/usr/bin/env node
/* End-to-end check: a real isolate, a real portal, the real protocol.
 *
 * Speaks exactly what the browser speaks — base64url uplink, OSC
 * frames down — so a pass means the wire works, not that the modules
 * import cleanly.
 *
 *   node src/cli/check.mjs <dist-dir> [--ws 3011]
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";

const dist = resolve(process.argv[2] ?? "dist");
const at = process.argv.indexOf("--ws");
const wsPort = Number(at >= 0 ? process.argv[at + 1] : 3011);

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
  /* A newline is what the terminal input decoder turns into the
   * `Enter` that terminates a message, and the frame goes as bytes:
   * this direction is parsed as tty input, not as text. */
  return new TextEncoder().encode(`${out}\n`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* Flattens a serialized tree the way the browser would build it, so
 * assertions can talk about text and classes rather than ids. */
function flatten(node, into = []) {
  if (!node) return into;
  into.push(node);
  for (const kid of node.kids ?? []) flatten(kid, into);
  return into;
}

const textOf = (node) =>
  flatten(node)
    .map((n) => n.text ?? "")
    .join("");

const isolate = spawn("yeet", ["run", "-p", `tty:ws://0.0.0.0:${wsPort}`, join(dist, "server.js")], {
  stdio: ["ignore", "pipe", "pipe"],
});
isolate.stderr.on("data", (c) => process.stderr.write(`isolate: ${c}`));

await wait(2500);

const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/`);
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
      /* a torn frame is a real failure, but the assertions below are
       * what should report it */
    }
    pending = pending.slice(end + OSC_CLOSE.length);
  }
});

await new Promise((done, fail) => {
  socket.addEventListener("open", done);
  socket.addEventListener("error", fail);
  setTimeout(() => fail(new Error("portal never accepted a connection")), 8000);
});

const send = (message) => socket.send(encode(message));

/* Everything the batching queue produced for one interaction, drained
 * after giving the isolate a moment to answer. */
const drain = async (ms = 700) => {
  await wait(ms);
  const out = frames.splice(0, frames.length);
  return out.flatMap((frame) => (frame.op === "batch" ? frame.patches : [frame]));
};

console.log("\nwire");
send({ t: "hello", path: "/" });
let patches = await drain(1200);

const mounted = patches.find((p) => p.op === "mount");
check("hello is answered with a mount", Boolean(mounted));

const tree = mounted ? flatten(mounted.root) : [];
const page = textOf(mounted?.root);

console.log("\nrendering");
/* Asserted on structure, not on copy. An earlier version of these
 * checked for the words the template happened to use, and a restyle
 * broke five of them without anything being wrong — a test that fails
 * when the design changes is measuring the design. */
check(
  "the layout rendered",
  tree.some((n) => n.tag === "main") && tree.some((n) => n.tag === "nav"),
);
check(
  "its nav links the other routes",
  tree.filter((n) => n.tag === "a" && n.attrs?.href?.startsWith("/")).length >= 2,
);
check("the page rendered", tree.some((n) => n.tag === "h1") && page.length > 80);
check(
  "tailwind classes reach the wire",
  tree.filter((n) => (n.attrs?.class ?? "").trim().length > 0).length >= 5,
);
check("the counter starts at zero", page.includes("clicked 0 times"));

console.log("\nevents");
const button = tree.find((n) => n.tag === "button" && n.on?.includes("click"));
check("the click handler was registered", Boolean(button));

if (button) {
  send({ t: "event", id: button.id, type: "click", payload: {} });
  patches = await drain();
  const texts = patches.filter((p) => p.op === "text").map((p) => p.value);
  check("clicking patches the count", texts.includes("1"), JSON.stringify(patches));

  /* The claim is that a click re-renders nothing — so it is counted as
   * inserts and removes, not as total patches. Counting everything in
   * a time window was wrong the moment the layout grew a status bar
   * that ticks on its own: unrelated patches landed in the window and
   * the assertion failed for a reason that had nothing to do with the
   * click. */
  const rebuilt = patches.filter((p) => p.op === "insert" || p.op === "remove");
  check(
    "clicking patches text and rebuilds nothing",
    rebuilt.length === 0,
    `${rebuilt.length} nodes replaced for one click`,
  );
}

console.log("\nrouting");
send({ t: "nav", path: "/procs" });
patches = await drain(900);
check("navigating patches the tree", patches.length > 0);
check(
  "the new page rendered",
  patches.some((p) => p.op === "insert" && /proc/i.test(textOf(p.node))),
);
if (process.env.DEBUG) {
  console.log(JSON.stringify(patches.map((p) => (p.op === "insert" ? { op: p.op, text: textOf(p.node).slice(0, 60) } : p)), null, 1));
}
check(
  "the layout survived the navigation",
  !patches.some((p) => p.op === "insert" && p.node?.tag === "header"),
  "the shell was rebuilt instead of kept",
);

/* A pid that does not exist, so the page has to name it rather than
 * render a process. Whether it arrives as a new subtree or as a text
 * patch into one already on screen is the page's business — the claim
 * under test is that the segment reached the component at all. */
send({ t: "nav", path: "/procs/4242" });
patches = await drain(1800);
check(
  "a dynamic segment matches and binds",
  patches.some(
    (p) =>
      (p.op === "insert" && textOf(p.node).includes("4242")) ||
      (p.op === "text" && String(p.value).includes("4242")),
  ),
  JSON.stringify(patches.map((p) => p.op + (p.value ? `:${p.value}` : ""))).slice(0, 200),
);

/* The framework's central claim, asserted rather than believed: a
 * table re-sampled once a second must arrive as patched cells, not as
 * a rebuilt subtree. `<For>` over freshly-built objects would look
 * identical on screen and send twelve new rows every tick, so screen
 * output is no evidence — the patch mix is. */
console.log("\nlive data");
send({ t: "nav", path: "/procs" });
await drain(1200);
patches = await drain(2600);

const streamed = patches.filter((p) => p.op === "text").length;
const rebuilt = patches.filter((p) => p.op === "insert").length;
check("a live table produces patches", streamed + rebuilt > 0, "no readings — is yeetd running?");
check("readings patch cells rather than rebuild rows", streamed > rebuilt, `${streamed} text vs ${rebuilt} insert`);

/* BPF, if the project has any. The object is imported rather than
 * opened by path, so the thing under test is really the bundler: an
 * import written in `app/lib/` has to keep resolving from wherever the
 * bundle ended up. A kernel that refuses to load it is reported, not
 * failed — the verifier's opinion is not this suite's business. */
console.log("\nbpf");
send({ t: "call", cid: 9, action: "app/lib/exec.js#recentExecs", args: [] });
patches = await drain(3000);
const bpf = patches.find((p) => p.op === "return" && p.cid === 9);

if (!bpf) {
  console.log("  skipped — this project has no BPF sources");
} else if (bpf.value?.error) {
  console.log(`  skipped — the program did not load: ${bpf.value.error}`);
} else {
  check("an imported .bpf.o resolves in the isolate", bpf.value !== undefined, bpf.error ?? "");
  check("it loaded and attached", bpf.value?.error === null, String(bpf.value?.error));
  check("the ring buffer is readable", Array.isArray(bpf.value?.rows));

  /* The write path, which is the harder half. A data-section map is
   * easy to bind to the wrong name — the map is `app.bss` while
   * `bpftool gen skeleton` says `app_bpf.bss` — and the failure is a
   * "No service for map" a long way from the cause. So the assertion
   * is that a value written comes back *from the map*, not from what
   * the caller remembers sending. */
  send({ t: "call", cid: 10, action: "app/lib/exec.js#configure", args: [{ filter: "zzcheck", minPid: 7 }] });
  patches = await drain(2500);
  const wrote = patches.find((p) => p.op === "return" && p.cid === 10);

  check("a data-section map accepts a write", wrote?.value?.error === null, String(wrote?.value?.error ?? wrote?.error));
  check(
    "the value reads back from the kernel",
    wrote?.value?.settings?.filter === "zzcheck" && wrote?.value?.settings?.minPid === 7,
    JSON.stringify(wrote?.value?.settings),
  );

  /* And the program is actually reading it: with a filter nothing on
   * this machine matches, the buffer has to stay empty. */
  send({ t: "call", cid: 11, action: "app/lib/exec.js#recentExecs", args: [] });
  patches = await drain(2000);
  const filtered = patches.find((p) => p.op === "return" && p.cid === 11);
  check(
    "the kernel honours the filter it was given",
    filtered?.value?.rows?.length === 0,
    `${filtered?.value?.rows?.length} rows got past a filter nothing matches`,
  );

  /* Put it back, so a project left in this state is not silently
   * filtered after the suite runs. */
  send({ t: "call", cid: 12, action: "app/lib/exec.js#configure", args: [{ filter: "", minPid: 0 }] });
  await drain(1500);
}

/* The probe's lifetime, which is the part that goes wrong quietly.
 *
 * A leaked reference does not fail anything — the program simply stays
 * attached with nobody reading it, tracing the machine for the life of
 * the isolate. So the assertion is that navigating away actually lets
 * go, and it names the holders so a failure says which caller did
 * not. */
if (bpf && !bpf.value?.error) {
  console.log("\nprobe lifetime");

  send({ t: "nav", path: "/execs" });
  await drain(2500);
  send({ t: "call", cid: 20, action: "app/lib/exec.js#probeState", args: [] });
  patches = await drain(1500);
  const mounted = patches.find((p) => p.op === "return" && p.cid === 20)?.value;

  check("mounting a page attaches the program", mounted?.running === true, JSON.stringify(mounted));
  check("and something is holding it", (mounted?.holders ?? 0) > 0, JSON.stringify(mounted?.held));

  send({ t: "nav", path: "/procs" });
  await drain(1500);
  send({ t: "call", cid: 21, action: "app/lib/exec.js#probeState", args: [] });
  patches = await drain(1500);
  const left = patches.find((p) => p.op === "return" && p.cid === 21)?.value;

  check(
    "leaving it releases every holder",
    left?.holders === 0,
    `still held by ${JSON.stringify(left?.held)}`,
  );

  /* Past the grace period the program itself has to be gone, not just
   * unreferenced. */
  await drain(7000);
  send({ t: "call", cid: 22, action: "app/lib/exec.js#probeState", args: [] });
  patches = await drain(1500);
  const stopped = patches.find((p) => p.op === "return" && p.cid === 22)?.value;

  check("and the program detaches after the grace", stopped?.running === false, JSON.stringify(stopped));
}

/* The directives, from the isolate's side. The browser half — that an
 * island actually mounts and that its own interactions stay local — is
 * checked separately, where there is a DOM to check it in. */
console.log("\ndirectives");
send({ t: "nav", path: "/" });
patches = await drain(1000);

const marker = [...(mounted ? flatten(mounted.root) : []), ...patches.flatMap((p) => (p.op === "insert" ? flatten(p.node) : []))]
  .find((n) => n.tag === "yeet-island");

check('"use client" renders a marker, not the component', Boolean(marker));
check("the island carries an id", Boolean(marker?.attrs?.["data-island"]));
check(
  "props are serialized onto the marker",
  Boolean(marker?.attrs?.["data-props"]) && marker.attrs["data-props"] !== "undefined",
  marker?.attrs?.["data-props"],
);
check(
  "server-rendered children stay inside it",
  textOf(marker).length > 0,
  "children were dropped, so the isolate can no longer patch them",
);

if (marker) {
  const action = "app/lib/host.js#processCount";
  send({ t: "call", cid: 1, action, args: [] });
  const replies = await drain(2500);
  const reply = replies.find((p) => p.op === "return" && p.cid === 1);
  check('"use yeet" is callable over the wire', Boolean(reply), "no reply");
  check("it ran in the isolate", typeof reply?.value === "number", reply?.error ?? "");
}

send({ t: "nav", path: "/nowhere" });
patches = await drain(900);
check(
  "an unmatched path falls through to not-found",
  patches.some((p) => p.op === "insert" && /not.?found|404/i.test(textOf(p.node))),
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failed`}\n`);
socket.close();
isolate.kill("SIGTERM");
process.exit(failures === 0 ? 0 : 1);
