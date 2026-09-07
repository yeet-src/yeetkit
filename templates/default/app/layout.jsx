/* The root layout: one header line and the buffer.
 *
 * It is an ordinary Solid component — but it runs in the isolate, so
 * the readings in the header need no data layer to reach it. The
 * sparkline is eight block glyphs rather than a chart: it costs one
 * text patch per tick, it copies and pastes, and at this size a drawn
 * chart would only be a picture of one.
 */
import { Link, createSignal, onCleanup } from "yeetkit";

import { hostStats } from "@/lib/host.js";

const SAMPLES = 24;
const BLOCKS = "▁▂▃▄▅▆▇█";

export default function Layout(props) {
  const [stats, setStats] = createSignal({ load: 0, cores: 1, procs: 0, mem: 0 });
  const [history, setHistory] = createSignal([]);

  const tick = async () => {
    try {
      const next = await hostStats();
      setStats(next);
      setHistory((past) => [...past, next.load].slice(-SAMPLES));
    } catch {
      /* A reading that fails should not take the frame down; the
       * header simply stops moving. */
    }
  };

  tick();
  const timer = setInterval(tick, 2000);
  onCleanup(() => clearInterval(timer));

  /* Scaled against the core count, not against the window's own peak.
   * Scaling to the peak looks livelier and lies: a machine sitting at
   * a steady load draws a full-height bar, which reads as saturated
   * when it means unchanged. */
  const spark = () => {
    const ceiling = Math.max(1, stats().cores);
    return history()
      .map((value) => {
        const step = Math.min(value / ceiling, 1) * (BLOCKS.length - 1);
        return BLOCKS[Math.round(step)];
      })
      .join("");
  };

  const routes = [
    ["/", "*home*", true],
    ["/procs", "*procs*", false],
    ["/execs", "*execs*", false],
  ];

  return (
    /* One line at the top and then the buffer. The readings that were
     * on the modeline moved up onto the nav row rather than going
     * away — they are the only live thing the shell itself shows. */
    <div class="min-h-screen bg-bg text-fg">
      <main class="mx-auto w-full max-w-4xl px-4 py-6">
        <nav class="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {routes.map(([href, name, end]) => (
            <Link
              href={href}
              end={end}
              class="text-dim hover:text-fg"
              activeClass="!text-magenta !underline underline-offset-4"
            >
              {name}
            </Link>
          ))}

          {/* One hue per reading, each beside the word that names it —
              the colour is a second channel, never the only one. */}
          <span class="ml-auto flex items-baseline gap-3 whitespace-nowrap">
            <span class="text-cyan">{spark}</span>
            <span class="text-dim">
              load <span class="text-yellow">{() => stats().load.toFixed(2)}</span>/
              {() => stats().cores}
            </span>
            <span class="text-dim">
              mem <span class="text-green">{() => Math.round(stats().mem * 100)}%</span>
            </span>
            <span class="text-dim">
              proc <span class="text-blue">{() => stats().procs}</span>
            </span>
          </span>
        </nav>

        {props.children}
      </main>
    </div>
  );
}
