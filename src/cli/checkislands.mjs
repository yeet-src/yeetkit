#!/usr/bin/env node
/* The browser half of an island, in a DOM.
 *
 * `check.mjs` proves the isolate sends a marker and answers a call.
 * This proves the other side: that the marker actually becomes a
 * running Solid component, that the server's children survive being
 * adopted by it, and — the claim that justifies the whole feature —
 * that an island's own interactions produce no socket traffic at all.
 *
 * Skipped when jsdom is not installed, which is the normal case in a
 * user's project: it is one of this framework's own dev dependencies,
 * not something an app has to carry.
 *
 *   node src/cli/checkislands.mjs <project-dir>
 */

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

const project = resolve(process.argv[2] ?? ".");
const bundle = join(project, "dist", "islands.js");

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.log("\nislands\n  skipped — jsdom is not installed\n");
  process.exit(0);
}

if (!existsSync(bundle)) {
  console.log("\nislands\n  skipped — no dist/islands.js; run a build first\n");
  process.exit(0);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("\nislands");

const dom = new JSDOM(`<!doctype html><body><div id="host"></div></body>`, { url: "http://localhost/" });
for (const k of ["document","Node","Element","HTMLElement","Text","Comment","DocumentFragment","Event","CustomEvent","SVGElement"]) {
  globalThis[k] = dom.window[k];
}
globalThis.window = dom.window;

const islands = await import(`file://${bundle}`);
check("the bundle exposes the island runtime", typeof islands.mount === "function");

const sent = [];
islands.setTransport((m) => {
  sent.push(m);
  // reply the way the isolate would
  setTimeout(() => islands.settle({ cid: m.cid, value: { node: "v0", host: "h", load: "0.1", processes: 42 } }), 10);
});

// the marker the server would have sent, with server-rendered children inside
const host = dom.window.document.getElementById("host");
host.innerHTML = `<yeet-island data-island="app/lib/Filter.jsx#default" data-props='{"label":"details"}'><p id="srv">server content</p></yeet-island>`;
const marker = host.firstChild;

islands.mount(marker, marker.getAttribute("data-island"), marker.getAttribute("data-props"));
await new Promise(r => setTimeout(r, 50));

const text = marker.textContent;
check("an island mounts and renders", /hide details/.test(text), text.slice(0, 80));
check("server-rendered children survive the handover", !!dom.window.document.getElementById("srv"));
check("props crossed the boundary", text.includes("details"));

// local interaction: click hide -> no message sent, DOM changes
const buttons = marker.querySelectorAll("button");
buttons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 20));
check("an island interaction costs no socket traffic", sent.length === 0, `${sent.length} messages sent`);
check("the interaction updated the DOM locally", /show details/.test(marker.textContent));

// server action from the island
buttons[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 80));
check("a server call leaves the island", sent[0]?.t === "nodecall", JSON.stringify(sent[0]));
check("its reply renders in the island", marker.textContent.includes("42 processes"));
console.log(`\n${failures === 0 ? "islands ok" : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
