/* A dynamic segment, with the detail query behind it.
 *
 * `props.params` is a getter over the router's match, so navigating
 * from /procs/1 to /procs/2 re-runs the query rather than rebuilding
 * the page — and the structure below is built once, with the reactive
 * reads down at the leaves, so a refresh patches the values that moved
 * instead of replacing the block.
 */
import { Show, createEffect, createSignal, onCleanup, Link } from "yeetkit";

const mb = (bytes) => `${((bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`;

/* A plain function, called as `{Row(...)}`, not a component: the
 * argument is an accessor, so the value it renders stays live. */
const Row = (label, value) => (
  <div class="flex gap-4">
    <dt class="w-20 shrink-0 text-dim">{label}</dt>
    <dd class="min-w-0 break-all text-fg">{value}</dd>
  </div>
);

export default function Proc(props) {
  const [proc, setProc] = createSignal(null);
  const [gone, setGone] = createSignal(false);

  createEffect(() => {
    const pid = Number(props.params.pid);
    let stopped = false;

    const tick = async () => {
      const result = await yeet.graph
        .query(
          `{ proc(pid: ${pid}) {
               pid uid exe cwd cmdline
               stat { comm state ppid num_threads rss_bytes }
               io { read_bytes write_bytes } } }`,
        )
        .catch(() => null);

      if (stopped) return;
      const found = result?.data?.proc;
      setGone(!found);
      if (found) setProc(found);
    };

    tick();
    const timer = setInterval(tick, 1000);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });

  return (
    <section class="space-y-4">
      <Link href="/procs" end class="text-blue hover:underline">
        [back to *procs*]
      </Link>

      {/* The callback form of `Show` builds its block once and hands
          down an accessor — so a refresh a second later patches the
          numbers rather than replacing the whole card. */}
      {/* The empty state has to say which it is: a pid that has not
          answered yet and one that does not exist look the same
          otherwise, and the second is the common case when a link goes
          stale. */}
      <Show
        when={proc()}
        fallback={
          <p class="text-dim">
            {() => (gone() ? `No process ${props.params.pid}.` : "reading…")}
          </p>
        }
      >
        {(p) => (
          <>
            <h1 class="comment">
              {p().stat?.comm} <span class="text-dim">#{p().pid}</span>
              {() => (gone() ? <span class="ml-2 text-red">(exited)</span> : null)}
            </h1>
            <dl class="space-y-0.5">
              {Row("state", () => p().stat?.state)}
              {Row("ppid", () => p().stat?.ppid)}
              {Row("threads", () => p().stat?.num_threads)}
              {Row("rss", () => mb(p().stat?.rss_bytes))}
              {Row("read", () => mb(p().io?.read_bytes))}
              {Row("written", () => mb(p().io?.write_bytes))}
              {Row("exe", () => p().exe || "—")}
              {Row("cwd", () => p().cwd || "—")}
              {Row("cmdline", () => (p().cmdline ?? []).join(" ") || "—")}
            </dl>
          </>
        )}
      </Show>
    </section>
  );
}
