/* A host resource that starts when something needs it and stops when
 * nothing does.
 *
 * A BPF program is the case this exists for. Attaching one is not free
 * — the verifier runs, maps are created, a hook is installed — and
 * leaving it attached because a page was open once is worse: the
 * kernel keeps doing the work for nobody. So the lifetime belongs to
 * whoever is looking.
 *
 * Three things make that harder than an `onCleanup`:
 *
 *   sharing    one isolate serves every viewer, and several components
 *              may want the same probe. It starts on the first holder
 *              and stops on the last, never once per reader.
 *   churn      navigating away and back would otherwise reload and
 *              re-verify the program for nothing, so the last release
 *              starts a grace period rather than a teardown.
 *   overlap    a release can land while the start is still in flight,
 *              and a hold can land during the grace. Both are ordinary
 *              here rather than a race to lose.
 */

import { onCleanup } from "solid-js";

export function createProbe({ start, stop, linger = 3000, name = "probe" }) {
  let handle = null;
  let starting = null;
  let grace = null;
  let failure = null;

  /* One entry per live reference, so `state` can name them. */
  const tickets = new Set();
  const holders = () => tickets.size;

  const cancelGrace = () => {
    if (grace === null) return;
    clearTimeout(grace);
    grace = null;
  };

  /* Takes a reference and returns the handle. The `release` it hands
   * back is idempotent, because a caller that releases twice — a
   * generator whose `finally` runs after an explicit cancel — should
   * not take the probe down under someone else.
   */
  const acquire = async (label = "?") => {
    /* The label is only for `state`: a refcount that is wrong tells
     * you nothing about which caller forgot to let go, and that is
     * exactly the question you have when one is stuck at 1. */
    const ticket = { label, at: Date.now() };
    tickets.add(ticket);
    cancelGrace();

    /* A previous failure is not sticky: the kernel may have been busy,
     * or the program may have been rebuilt since. */
    failure = null;
    starting ??= Promise.resolve().then(start);

    const release = () => {
      if (!tickets.delete(ticket)) return; // idempotent
      if (holders() === 0) beginGrace();
    };

    try {
      handle = await starting;
      return { handle, release };
    } catch (error) {
      /* Clear the in-flight promise so the next holder retries rather
       * than awaiting a promise that already rejected. */
      starting = null;
      handle = null;
      failure = String(error?.message ?? error);
      release();
      throw error;
    }
  };

  function beginGrace() {
    cancelGrace();
    grace = setTimeout(teardown, linger);
  }

  async function teardown() {
    grace = null;
    /* Someone took a reference during the grace period. */
    if (holders() > 0) return;

    const inflight = starting;
    starting = null;
    handle = null;

    /* A start still in flight is awaited before stopping it —
     * otherwise the teardown runs against nothing and the program
     * attaches a moment later with no holder to stop it. */
    let live = null;
    try {
      live = await inflight;
    } catch {
      return; // it never started; nothing to stop
    }

    if (holders() > 0) return; // and again, now that the await is done

    try {
      await stop(live);
    } catch (error) {
      console.warn(`${name}: stop failed: ${error?.message ?? error}`);
    }
  }

  return {
    acquire,

    /* The component form. `onCleanup` is registered before the first
     * `await`, so it belongs to the component that called this rather
     * than to whatever happens to be running when the start resolves.
     */
    hold(label = "component") {
      const taken = acquire(label);
      /* The rejection is handled by whoever awaits `hold()`; this
       * guard only stops an unhandled rejection from reaching the
       * isolate, which treats one as fatal. */
      taken.then(null, () => {});
      onCleanup(() => taken.then(({ release }) => release(), () => {}));
      return taken.then(({ handle: held }) => held);
    },

    /** For a status line: whether anything holds it, and why not. */
    get state() {
      return {
        running: holders() > 0 || handle !== null,
        holders: holders(),
        /* Who is holding it, oldest first — the answer to "why is this
         * still attached?" */
        held: [...tickets].sort((a, b) => a.at - b.at).map((t) => t.label),
        stopping: grace !== null,
        error: failure,
      };
    },
  };
}
