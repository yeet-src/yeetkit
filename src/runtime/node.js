/* Calling the host from the isolate.
 *
 * A `"use server"` function runs in the Node process, because that is
 * where `fs`, `fetch` and npm are. The isolate reaches it over the
 * same portal the browser used to connect to — except the browser no
 * longer does. Node terminates the portal and re-serves browsers
 * itself, so a `nodecall` frame is consumed by the hub and never
 * reaches anyone else. The isolate broadcasts, but there is only one
 * listener.
 *
 * The reply comes back on the uplink, which is per-peer, and Node is
 * the peer.
 */

let write = () => {
  throw new Error("the isolate is not mounted");
};

/** Installed by `mount`, which owns the tty. */
export const setWriter = (fn) => {
  write = fn;
};

let nextCall = 1;
const pending = new Map();

/* A call outlives no more than this. Without it a hub that died
 * mid-call leaves the caller waiting forever — and in a render path
 * that is a page that never finishes. */
const TIMEOUT_MS = 30_000;

export function nodeCall(action, args) {
  const cid = nextCall++;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(cid);
      reject(new Error(`"use server" ${action} timed out — is the yeetkit host running?`));
    }, TIMEOUT_MS);

    pending.set(cid, { resolve, reject, timer });
    write({ op: "nodecall", cid, action, args });
  });
}

/** Routed here by `mount` when the hub answers on the uplink. */
export function settleNode({ cid, value, error }) {
  const waiting = pending.get(cid);
  if (!waiting) return;
  pending.delete(cid);
  clearTimeout(waiting.timer);
  if (error) reject(waiting, error);
  else waiting.resolve(value);
}

function reject(waiting, error) {
  waiting.reject(new Error(error));
}
