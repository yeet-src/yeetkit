"use yeet";

/* A BPF program with a lifetime, plus its read and write paths.
 *
 * The object is *imported*: `#/` is the linked objects `make bpf`
 * produces from `bpf/*.bpf.c`, and the isolate's loader turns an
 * import ending in `.bpf.o` into a `BpfObject`. yeetkit rewrites the
 * specifier at bundle time so it keeps resolving after the bundler has
 * moved the code somewhere else.
 *
 * The program is attached while something is looking and detached when
 * nothing is. `createProbe` refcounts that: it starts on the first
 * holder and waits out a grace period on the last, so navigating away
 * and back does not reload and re-verify it. A page holds it for as
 * long as it is mounted, a stream for as long as it is read, a
 * one-shot call for the length of the call.
 *
 * Two consequences worth knowing. The imported object cannot be
 * re-attached — its binds accumulate, and a second `start()` fails
 * with "Map 'events' already bound" — so each attach mints a fresh
 * `BpfObject` from the imported one's path. And the settings live in
 * the program's `.bss`, which the load creates: they last exactly as
 * long as the attachment, and a probe that stops forgets them.
 */

import { BpfObject, DataSec, RingBuf } from "yeet:bpf";
import { createProbe } from "yeetkit";

import program from "#/app.bpf.o";

const KEEP = 40;
const COMM_LEN = 16;

/* The name libbpf gives the object's `.bss`. The prefix is the object
 * name up to its first dot — `app.bpf.o` gives `app`, not `app_bpf` —
 * and libbpf truncates that to 8 characters. `bpftool gen skeleton`
 * prints `app_bpf.bss` instead, because it is naming a C identifier
 * rather than the map; going by that is how you end up with "No
 * service for map". */
const BSS = "app.bss";

const recent = [];
const waiters = new Set();

/* `comm` arrives as the fixed 16-byte array the struct declares, NUL
 * padded — the C side has no notion of a shorter string. */
const commOf = (bytes) => {
  /* A fixed C array comes back from a ring-buffer event as an array,
   * and from a data section as an object keyed by index. Both are the
   * same 16 bytes. */
  const values = Array.isArray(bytes) ? bytes : Object.values(bytes ?? {});
  const out = [];
  for (const byte of values) {
    if (!byte) break;
    out.push(String.fromCharCode(byte));
  }
  return out.join("");
};

/* And the same in reverse, because the global is a fixed array too: a
 * shorter filter has to be NUL padded to the declared width, or the
 * bytes left over from the previous one would still be sitting there. */
const bytesOf = (text) => {
  const out = new Array(COMM_LEN).fill(0);
  const source = String(text ?? "");
  for (let i = 0; i < Math.min(source.length, COMM_LEN - 1); i += 1) {
    out[i] = source.charCodeAt(i) & 0x7f;
  }
  return out;
};

const probe = createProbe({
  name: "exec",

  /* Long enough that clicking between pages does not reload the
   * program, short enough that a closed tab stops tracing the machine
   * within a few seconds. */
  linger: 5000,

  async start() {
    /* A fresh object per attach. The imported one is a module
     * singleton whose binds are cumulative, so reusing it works
     * exactly once. */
    const control = await new BpfObject({ exe: program.exe })
      .bind("events", { kind: "ringbuf", btf_struct: "exec_event" })
      /* The data section, so the globals can be patched while
       * attached. */
      .bind(BSS, { kind: "data" })
      /* A tracepoint carries its own hook in its SEC() name, so there
       * is nothing to configure — but it still has to be attached, or
       * the program loads and never runs. */
      .attach("on_exec")
      .start();

    await new RingBuf(control, "events").subscribe((wrapped) => {
      /* Guarded: an exception on a ring-buffer callback takes the
       * whole isolate down rather than failing one reader, and
       * surfaces later as an unrelated error. One malformed event
       * should cost one row. */
      try {
        const event = wrapped?.exec_event ?? wrapped;
        const row = {
          pid: Number(event.pid ?? 0),
          ppid: Number(event.ppid ?? 0),
          comm: commOf(event.comm),
          at: Date.now(),
        };
        recent.unshift(row);
        if (recent.length > KEEP) recent.length = KEEP;
        /* Every open `tail()` gets it immediately; nothing polls. */
        for (const waiter of waiters) waiter(row);
      } catch {
        // dropped
      }
    });

    return { control, bss: new DataSec(control, BSS) };
  },

  async stop({ control }) {
    await control.stop();
    /* The rows left over came from an attachment that no longer
     * exists; keeping them would make a stopped probe look live. */
    recent.length = 0;
  },
});

/* Held by a component for as long as it is mounted — the point of the
 * pattern. Call it from a page rather than an island: the `onCleanup`
 * inside belongs to the calling component, and an island calling this
 * over the wire has no component on this side to belong to.
 */
export function holdProbe() {
  return probe.hold("page").then(() => probe.state);
}

/** Whether the program is attached, for a status line. */
export function probeState() {
  return probe.state;
}

/* Every reading below takes its own reference, so a `curl` against the
 * HTTP route works whether or not a page is open — and the grace
 * period means a burst of them attaches once rather than once each.
 */
const using = async (fn) => {
  const { handle, release } = await probe.acquire("call");
  try {
    return await fn(handle);
  } finally {
    release();
  }
};

/** Every exec the filter let through, newest first. */
export async function recentExecs() {
  try {
    return await using(() => ({ error: null, rows: recent.slice(0, 20) }));
  } catch (error) {
    return { error: String(error?.message ?? error), rows: [] };
  }
}

/* A STREAM: an exported async generator, so a reader is pushed to
 * rather than polling — and one that holds the probe for exactly as
 * long as it is being read. Cancel the stream, or close the tab, and
 * the `finally` releases it.
 */
export async function* tail(stop) {
  const { release } = await probe.acquire("stream");

  const queue = [];
  let wake = null;
  const waiter = (row) => {
    queue.push(row);
    wake?.();
  };
  waiters.add(waiter);

  try {
    /* Whatever is already collected, so a reader arriving mid-session
     * sees context rather than an empty table until the next exec. */
    for (const row of [...recent].reverse()) yield row;

    for (;;) {
      while (queue.length > 0) yield queue.shift();

      /* Waiting on the stop token as well as on the next event, and
       * this is not belt-and-braces.
       *
       * `iterator.return()` queues behind the pending `next()` that
       * any reader has in flight, and this loop can go round without
       * reaching a `yield` — so on a quiet machine that `next()` never
       * settles, the return is never reached, and the `finally` below
       * never runs. The probe would stay attached with nobody reading
       * it. The token is the thing that can actually interrupt the
       * wait.
       */
      await (stop?.until ?? ((work) => work))(
        new Promise((resolve) => (wake = resolve)),
      );
      if (stop?.aborted) return;
    }
  } finally {
    waiters.delete(waiter);
    release();
  }
}

/* Writing the map. A control in the browser lands in the kernel's own
 * decision, and the filtering happens before an event is written to
 * the buffer — so a narrow filter costs less than a wide one rather
 * than more.
 */
export async function configure({ paused, minPid, filter } = {}) {
  try {
    return await using(async ({ bss }) => {
      await bss.patch({
        paused: paused ? 1 : 0,
        min_pid: Math.max(0, Number(minPid) || 0),
        want: bytesOf(filter),
      });

      /* Cleared on every change: the rows already collected were let
       * through by the *previous* settings, and leaving them on screen
       * would make the new filter look broken. */
      recent.length = 0;
      return read(bss);
    });
  } catch (error) {
    return { error: String(error?.message ?? error), settings: null };
  }
}

/** Read back from the map rather than from what we last sent it. */
export async function settings() {
  try {
    return await using(({ bss }) => read(bss));
  } catch (error) {
    return { error: String(error?.message ?? error), settings: null };
  }
}

async function read(bss) {
  const live = await bss.read();
  return {
    error: null,
    settings: {
      paused: Boolean(live?.paused),
      minPid: Number(live?.min_pid ?? 0),
      filter: commOf(live?.want),
    },
  };
}

/** Forget the collected events without touching the program. */
export async function clear() {
  const had = recent.length;
  recent.length = 0;
  return { error: null, cleared: had };
}
