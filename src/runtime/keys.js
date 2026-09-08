/* Keys that reach no element still reach the app: the client forwards
 * every keydown outside an input as a `key` message, and the isolate
 * hands it to whoever asked. A page registers with `onKey` and gets a
 * function to unregister — pair it with `onCleanup`, so a route that
 * is no longer shown stops answering to its shortcuts.
 *
 *   const off = onKey((k) => { if (k.key === "a") openMenu(); });
 *   onCleanup(off);
 *
 * A key is `{ key, code, ctrl, alt, shift, meta }`, as the browser saw
 * it. Handlers run newest first, and one that returns `true` has
 * handled the key — a modal menu can take `j` without the page under
 * it also moving. */

const handlers = [];

export function onKey(handler) {
  handlers.unshift(handler);
  return () => {
    const at = handlers.indexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}

export function dispatchKey(message) {
  for (const handler of [...handlers]) {
    try {
      if (handler(message) === true) return true;
    } catch {
      // one handler's failure is its own
    }
  }
  return false;
}
