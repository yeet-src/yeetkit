"use client";

/* The control plane, as a form.
 *
 * This is where all three runtimes meet. The inputs are browser state —
 * typing has to be instant, and a keystroke that took a round trip
 * would feel broken — so this is an island, with its own Solid and its
 * own signals. Pressing *apply* calls a `"use yeet"` function, which
 * runs in the isolate and patches the BPF program's globals through
 * their data-section map. The kernel reads them on the next exec.
 *
 * So the path from this input to the kernel's decision is: browser →
 * hub → isolate → map. And the filtering then happens in the kernel,
 * before an event is written to the ring buffer at all — which is why
 * this is worth doing here rather than filtering the rows on their way
 * out.
 */

import { createSignal } from "solid-js";

import { configure } from "@/lib/exec.js";

export default function ExecFilter(props) {
  /* Seeded from the map's current contents, then owned locally: the
   * page reads the map, this holds what you are typing. */
  const [filter, setFilter] = createSignal(props.filter ?? "");
  const [minPid, setMinPid] = createSignal(String(props.minPid ?? 0));
  const [paused, setPaused] = createSignal(Boolean(props.paused));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(null);

  const apply = async (overrides = {}) => {
    setBusy(true);
    setError(null);
    try {
      const next = {
        filter: filter(),
        minPid: Number(minPid()) || 0,
        paused: paused(),
        ...overrides,
      };
      const result = await configure(next);
      if (result?.error) setError(result.error);
    } catch (failure) {
      setError(String(failure?.message ?? failure));
    } finally {
      setBusy(false);
    }
  };

  /* Pause is the one control that should not need a second click, so it
   * writes immediately rather than waiting for *apply*. */
  const togglePause = () => {
    const next = !paused();
    setPaused(next);
    apply({ paused: next });
  };

  return (
    <form
      class="flex flex-wrap items-baseline gap-4"
      onSubmit={(event) => {
        /* The client prevents the default already, but saying so here
           keeps this component honest on its own. */
        event.preventDefault?.();
        apply();
      }}
    >
      {/* Emacs would prompt for this in the minibuffer, so the labels
          sit inline and the fields are underlines rather than boxes. */}
      <label class="flex items-baseline gap-2">
        <span class="text-dim">comm:</span>
        <input
          class="w-32 border-b border-rule bg-transparent text-fg caret-fg outline-none focus:border-blue"
          placeholder="any"
          value={filter()}
          onInput={(event) => setFilter(event.target.value)}
        />
      </label>

      <label class="flex items-baseline gap-2">
        <span class="text-dim">pid ≥</span>
        <input
          class="w-20 border-b border-rule bg-transparent text-fg caret-fg outline-none focus:border-blue"
          type="number"
          min="0"
          value={minPid()}
          onInput={(event) => setMinPid(event.target.value)}
        />
      </label>

      <button
        type="submit"
        disabled={busy()}
        class="text-blue hover:underline disabled:text-dim disabled:no-underline"
      >
        [{busy() ? "writing…" : "apply"}]
      </button>

      <button
        type="button"
        onClick={togglePause}
        class="text-blue hover:underline"
      >
        [{paused() ? "resume" : "pause"}]
      </button>

      {/* Status is a word, not a colour: the colour only agrees with
          it. */}
      <span class={paused() ? "text-orange" : "text-dim"}>
        {paused() ? "(paused: dropping every event)" : "(filtering in the kernel)"}
      </span>

      {() =>
        error() && <p class="w-full text-red">error: {error()}</p>
      }
    </form>
  );
}
