"use client";

/* Runs in the browser, with its own Solid and its own state.
 *
 * Everything here is local: typing does not touch the socket, so there
 * is no round trip per keystroke and no shared state — two tabs filter
 * independently, which is the one thing an isolate-side component
 * cannot do. `props.children` is the server-rendered content, handed
 * over as live DOM: the isolate still patches those nodes while this
 * component decides whether to show them.
 *
 * It reaches both other runtimes: `snapshot()` is a `"use server"`
 * function in Node, and that one in turn calls a `"use yeet"` function
 * in the isolate.
 */
import { createSignal, Show } from "solid-js";

import { snapshot } from "./server.js";

export default function Filter(props) {
  const [open, setOpen] = createSignal(true);
  const [reading, setReading] = createSignal(null);

  return (
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-4">
        <button
          class="text-blue hover:underline"
          onClick={() => setOpen(!open())}
        >
          [{open() ? "hide" : "show"} {props.label}]
        </button>

        {/* A "use server" call: the query runs on the host, the browser
            gets the number. */}
        {/* One hop to the Node host, which reads a file with `fs` and
            asks the isolate for the process count on our behalf. */}
        <button
          class="text-blue hover:underline"
          onClick={async () => setReading(await snapshot())}
        >
          [ask the host]
        </button>

        <Show when={reading()}>
          {(r) => (
            <span class="text-dim">
              node {r().node} on {r().host} — load {r().load}, {r().processes} processes
            </span>
          )}
        </Show>
      </div>

      <div style={{ display: open() ? "block" : "none" }}>
        {props.children}
      </div>
    </div>
  );
}
