/* Data comes from the host, not from an API route.
 *
 * `yeet.graph` is the daemon's system graph — a GraphQL-ish query over
 * /proc — and this component calls it directly, because the component
 * is already running on the machine being measured. There is no route
 * handler, no serializer, no client-side cache, and no polling
 * endpoint. A second of wall time later, the only thing that crosses
 * the socket is the cells whose numbers moved.
 */
import { Index, Link, createSignal, onCleanup } from "yeetkit";

const HZ = 100; // USER_HZ — utime/stime are in clock ticks
const SHOWN = 12;

const kb = (bytes) => {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb.toFixed(0)}M`;
};

export default function Procs() {
  const [rows, setRows] = createSignal([]);
  const [error, setError] = createSignal(null);

  /* %CPU is a rate, so it needs the previous sample: ticks since the
   * last tick, over the wall time between them. */
  let previous = new Map();
  let sampledAt = 0;

  const tick = async () => {
    try {
      const result = await yeet.graph.query(
        `{ procs { pid cmdline stat { comm state utime stime num_threads rss_bytes } } }`,
      );

      const now = Date.now();
      const elapsed = sampledAt ? (now - sampledAt) / 1000 : 0;
      const current = new Map();

      const next = [];
      for (const proc of result?.data?.procs ?? []) {
        const stat = proc.stat;
        if (!stat) continue;

        const ticks = (stat.utime ?? 0) + (stat.stime ?? 0);
        current.set(proc.pid, ticks);
        const before = previous.get(proc.pid);

        next.push({
          pid: proc.pid,
          comm: stat.comm ?? "?",
          cmd: (proc.cmdline ?? []).join(" ").trim() || stat.comm,
          state: stat.state ?? "?",
          threads: stat.num_threads ?? 0,
          rss: stat.rss_bytes ?? 0,
          /* The first sample has nothing to compare against, so every
           * process reads 0% until the second one lands. */
          cpu: elapsed > 0 && before != null ? ((ticks - before) / HZ / elapsed) * 100 : 0,
        });
      }

      next.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
      previous = current;
      sampledAt = now;

      setRows(next.slice(0, SHOWN));
      setError(null);
    } catch (failure) {
      setError(String(failure?.message ?? failure));
    }
  };

  tick();
  const timer = setInterval(tick, 1000);
  onCleanup(() => clearInterval(timer));

  return (
    <section class="space-y-4">
      <h1 class="comment">processes — 1 Hz, only changed cells cross the wire</h1>

      {() =>
        error() && (
          <p class="text-red">error: {error()}</p>
        )
      }

      <div class="overflow-x-auto">
        <table class="w-full">
        {/* One rule under the header and nothing else — a tabulated
            list, not a card. */}
        <thead class="text-left">
          <tr class="border-b border-rule text-dim">
            <th class="py-1 pr-6 font-normal">pid</th>
            <th class="py-1 pr-6 font-normal">command</th>
            <th class="py-1 pr-6 text-right font-normal">thr</th>
            <th class="py-1 pr-6 text-right font-normal">rss</th>
            <th class="py-1 text-right font-normal">cpu</th>
          </tr>
        </thead>
        <tbody>
          {/* `Index`, not `For`, and the difference is the whole point.
              `For` is keyed by item identity, and every sample builds
              fresh objects — so each tick would throw away all twelve
              rows and send twelve new subtrees down the wire. `Index`
              keys by position and hands each row an accessor, so a
              tick patches the handful of numbers that actually moved.
              A ranking table is positional anyway: row 3 is "third
              hottest", not a particular process. */}
          <Index each={rows()}>
            {(row) => (
              <tr class="hover:bg-mode">
                <td class="py-0.5 pr-6">
                  <Link href={`/procs/${row().pid}`} end class="text-blue hover:underline">
                    {row().pid}
                  </Link>
                </td>
                <td class="max-w-0 truncate py-0.5 pr-6" title={row().cmd}>
                  {row().comm}
                </td>
                <td class="py-0.5 pr-6 text-right text-dim">{row().threads}</td>
                <td class="py-0.5 pr-6 text-right text-cyan">{kb(row().rss)}</td>
                {/* The one number that moves every tick. */}
                <td class="py-0.5 text-right text-yellow">{row().cpu.toFixed(1)}</td>
              </tr>
            )}
          </Index>
        </tbody>
        </table>
      </div>
    </section>
  );
}
