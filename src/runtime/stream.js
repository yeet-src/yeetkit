/* Cancelling a stream, which does not work the way it looks like it
 * should.
 *
 * `iterator.return()` is the obvious mechanism and it is not enough. A
 * `for await` loop always has a `next()` in flight, a `return()`
 * request queues behind it, and a generator that loops internally
 * without reaching a `yield` never settles that `next()` — so the
 * request is never reached and the `finally` never runs. A generator
 * waiting for the next kernel event on a quiet machine does exactly
 * that. Nothing times out; it simply stays alive holding whatever it
 * holds.
 *
 * So a stream that waits is handed a stop token as its last argument
 * and is expected to wait on it too:
 *
 *   export async function* tail(stop) {
 *     for (;;) {
 *       while (queue.length) yield queue.shift();
 *       await stop.until(nextEvent());   // resolves on either
 *       if (stop.aborted) return;        // ← runs the finally
 *     }
 *   }
 *
 * The token is appended by whatever drives the stream, so a generator
 * that ignores it still works — it is just not cancellable, which is
 * the situation this exists to make visible rather than silent.
 */

export function createStopToken() {
  let abort;
  const whenAborted = new Promise((resolve) => {
    abort = resolve;
  });

  const token = {
    aborted: false,
    whenAborted,

    /* Wait for `work`, or for the stop — whichever comes first. The
     * caller checks `aborted` afterwards; this only guarantees it
     * stops waiting. */
    until: (work) => Promise.race([work, whenAborted]),
  };

  return {
    token,
    stop() {
      if (token.aborted) return;
      token.aborted = true;
      abort();
    },
  };
}

/* Reading a stream from a component in the same process.
 *
 * `for await` would work, but leaves the cancellation broken in the
 * way described above — so this drives the iterator, aborts the token
 * on cleanup, and asks for the return as well. Registered with
 * `onCleanup`, so unmounting is what stops it.
 */
export function readStream(open, onValue, { onError } = {}) {
  const { token, stop } = createStopToken();
  const iterator = open(token);

  (async () => {
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || token.aborted) break;
        onValue(value);
      }
    } catch (error) {
      if (!token.aborted) onError?.(error);
    }
  })();

  return () => {
    stop();
    /* Both: the token unblocks the wait, and the return tells a
     * generator that *is* at a yield to finish now. */
    iterator.return?.().catch?.(() => {});
  };
}
