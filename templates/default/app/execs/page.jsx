/* Live from a BPF ring buffer.
 *
 * The kernel side is bpf/exec.bpf.c, linked into bin/app.bpf.o by
 * `make bpf` and imported by app/lib/exec.js. Nothing here polls the
 * kernel: the tracepoint fires on the exec path itself, and this page
 * only asks what has arrived since it last looked.
 */
import { Index, createSignal, onCleanup, readStream } from "yeetkit";

import ExecFilter from "@/lib/ExecFilter.jsx";
import { holdProbe, probeState, settings, tail } from "@/lib/exec.js";

export default function Execs() {
  const [rows, setRows] = createSignal([]);
  const [error, setError] = createSignal(null);
  const [live, setLive] = createSignal(null);
  const [probe, setProbe] = createSignal({ running: false, holders: 0 });

  /* The program is attached because this page is mounted, and detached
   * a few seconds after it is not. `holdProbe()` registers the release
   * with this component's own `onCleanup`, so navigating away is what
   * lets go — nothing has to remember to. */
  holdProbe()
    .then(setProbe)
    .catch((failure) => setError(String(failure?.message ?? failure)));

  /* Shown rather than assumed: a status line is the only way to tell a
   * probe that is running from one that failed to start. */
  const watch = setInterval(async () => setProbe(await probeState()), 1000);
  onCleanup(() => clearInterval(watch));

  /* A stream, not a poll. This page runs in the isolate, so `tail()`
   * is an ordinary async generator in the same process — no wire, no
   * interval, and a row appears when the kernel produces it rather
   * than up to half a second later.
   *
   * `readStream` drives it and hands it a stop token, which is what
   * makes unmounting actually stop it: `return()` on its own queues
   * behind a pending `next()` that a waiting generator may never
   * settle. */
  onCleanup(
    readStream(
      (stop) => tail(stop),
      (row) => setRows((current) => [row, ...current].slice(0, 20)),
      { onError: (failure) => setError(String(failure?.message ?? failure)) },
    ),
  );

  /* Read once, to seed the form with what the map actually holds
   * rather than with what this page assumes it holds. */
  settings().then((result) => setLive(result.settings));

  return (
    <section class="space-y-4">
      <h1 class="comment">execs — a bpf tracepoint, pushed, not polled</h1>

      {/* The probe's own state, in words. */}
      <p class="text-dim">
        probe{" "}
        <span class={() => (probe().running ? "text-green" : "text-orange")}>
          {() => (probe().running ? "attached" : "detached")}
        </span>
        {() => (probe().stopping ? " (stopping)" : "")} · {() => probe().holders} holder
        {() => (probe().holders === 1 ? "" : "s")}
      </p>
      <p class="max-w-prose text-dim">
        Every <span class="text-fg">execve</span> on this machine, from a BPF
        tracepoint. Run something in a terminal and it appears here — and the filter below is
        written into the program's map, so it is the kernel doing the filtering, not this page.
      </p>

      {() =>
        error() && (
          <div class="space-y-0.5">
            <p class="text-orange">warning: the program did not load</p>
            <p class="text-dim">{error()}</p>
            <p class="text-dim">
              Loading BPF needs privileges and a kernel the verifier agrees with — try{" "}
              <span class="text-fg">make veristat</span>.
            </p>
          </div>
        )
      }

      {/* An island: typing is local, and pressing apply writes the
          program's globals through their map. */}
      {() => {
        const current = live();
        return current ? (
          <ExecFilter filter={current.filter} minPid={current.minPid} paused={current.paused} />
        ) : null;
      }}

      <div class="overflow-x-auto">
        <table class="w-full">
        <thead class="text-left">
          <tr class="border-b border-rule text-dim">
            <th class="py-1 pr-6 font-normal">pid</th>
            <th class="py-1 pr-6 font-normal">ppid</th>
            <th class="py-1 font-normal">command</th>
          </tr>
        </thead>
        <tbody>
          <Index
            each={rows()}
            fallback={
              <tr>
                <td colspan="3" class="py-2 text-dim">
                  waiting for an exec<span class="caret ml-1" />
                </td>
              </tr>
            }
          >
            {(row) => (
              <tr class="hover:bg-mode">
                <td class="py-0.5 pr-6 text-blue">{row().pid}</td>
                <td class="py-0.5 pr-6 text-dim">{row().ppid}</td>
                <td class="py-0.5 text-green">{row().comm}</td>
              </tr>
            )}
          </Index>
        </tbody>
        </table>
      </div>
    </section>
  );
}
