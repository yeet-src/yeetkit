/* `"use server"`: functions an island is allowed to call.
 *
 * They run in the isolate — that is the whole point of them, since the
 * isolate is where the host is. The browser gets a stub that sends the
 * arguments up and awaits one reply, which makes a server action the
 * only way a client island reaches `yeet:*` at all.
 */

import { createStopToken } from "./stream.js";

const actions = new Map(); // id -> the real function
const streams = new Map(); // id -> the real async generator
const ids = new WeakMap(); // the real function -> its id

/** Called by the generated server entry, once per exported action. */
export function registerAction(id, fn) {
  if (typeof fn !== "function") {
    throw new Error(`"use server" export ${id} is a ${typeof fn}; only functions can be actions.`);
  }
  actions.set(id, fn);
  ids.set(fn, id);
  return fn;
}

/** The id of a function, if it is an action — how props encode one. */
export const idOf = (fn) => ids.get(fn);

/* Errors are returned, not thrown: the caller is a browser, and an
 * unhandled rejection in here would take the isolate down with it.
 */
export async function callAction(id, args) {
  const fn = actions.get(id);
  if (!fn) return { error: `no server action ${id}` };
  try {
    return { value: await fn(...args) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/* A `STREAM`: an exported async generator, reachable over the wire as
 * many values rather than one.
 *
 * The point is push instead of poll. A ring buffer that produces an
 * event when the kernel says so should not be asked "anything yet?"
 * twice a second — and a stream also gets *cancelled*, which polling
 * cannot express: when the last reader goes away the generator's
 * `finally` runs and whatever it was holding is released.
 */
export function registerStream(id, fn) {
  if (typeof fn !== "function") {
    throw new Error(`"${id}" is declared a stream but is a ${typeof fn}`);
  }
  streams.set(id, fn);
  ids.set(fn, id);
  return fn;
}

/* Starts one, handing each value to `emit`. Returns a cancel function
 * — calling it runs the generator's `finally` — so a reader that
 * disconnects does not leave the producer running forever.
 */
export function startStream(id, args, emit) {
  const fn = streams.get(id);
  if (!fn) {
    emit({ error: `no stream ${id}` });
    return () => {};
  }

  /* The token is appended to the generator's arguments, and the
   * iterator is driven by hand rather than with `for await`.
   *
   * Both matter for cancellation. `return()` alone queues behind a
   * pending `next()`, and a generator waiting on the next kernel event
   * may never reach a `yield` to settle it — so a closed tab would
   * leave the producer running, holding whatever it holds, for the
   * life of the isolate. The token is what it can actually wait on.
   */
  const { token, stop } = createStopToken();
  let iterator;

  const pump = async () => {
    try {
      iterator = fn(...args, token);
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || token.aborted) break;
        emit({ value });
      }
      if (!token.aborted) emit({ done: true });
    } catch (error) {
      if (!token.aborted) emit({ error: String(error?.message ?? error) });
    }
  };

  pump();

  return () => {
    stop();
    iterator?.return?.().catch?.(() => {});
  };
}
