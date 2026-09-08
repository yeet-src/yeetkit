/* Wires a Solid tree to the portal.
 *
 * Two lanes leave an isolate: the tty, which is bidirectional, and the
 * console, which only goes out. By default everything rides the tty.
 * In *direct* mode the view — the snapshot and every patch — is
 * written to the console lane instead, which the browser dials itself,
 * and the tty is left to the hub for what must stay private: `nodecall`
 * and the per-caller replies. The hub still carries events up, since
 * the console lane has no input side at all.
 *
 * The isolate cannot see a WebSocket connect, so the browser
 * announces itself: the client sends `hello` on open and on every
 * reconnect, and that — not startup — is what sends the tree. A
 * client that arrives late, or comes back after the isolate
 * restarted, is handed a snapshot of the tree as it stands now.
 *
 * One isolate is one running application shared by every connected
 * browser: the portal is a tty, and a tty is a broadcast. Two tabs
 * are two views of the same state, not two sessions. For an
 * instrument — which is what this is for — that is the useful
 * behaviour; it is also the reason there is no per-request rendering
 * anywhere in here.
 */

import { dispatchKey } from "./keys.js";
import { encodeFrame, uplinkReader } from "./protocol.js";
import { ROOT, dispatch, render, serialize, setEmitter } from "./renderer.js";
import { setWriter, settleNode } from "./node.js";
import { callAction, startStream } from "./rpc.js";
import { setLocation, setNavigator } from "./router.js";

export function mount(code, options = {}) {
  const { title = "yeetkit", onKey = null, onAsk = null, direct = false } = options;

  let live = false;

  /* Where the tree goes. Direct mode writes it as one console line per
   * frame — the lane has no PTY, so the frame arrives intact — and
   * every other frame in this file still uses `tty.write`. */
  const view = direct ? (frame) => console.log(frame) : (frame) => tty.write(frame);

  /* Patches are batched per tick. One signal write can drive several
   * bindings and a stream drives one every few milliseconds; sending
   * each as its own OSC frame costs a tty.write, a stringify and a
   * WebSocket message apiece. The queue drains on a microtask, so
   * everything one turn of the event loop produced leaves as a single
   * frame.
   */
  let queue = [];

  const flush = () => {
    const batch = queue;
    queue = [];
    if (batch.length === 0 || !live) return;
    view(encodeFrame(batch.length === 1 ? batch[0] : { op: "batch", patches: batch }));
  };

  const send = (patch) => {
    if (!live) return;
    if (queue.length === 0) queueMicrotask(flush);
    queue.push(patch);
  };
  setEmitter(send);
  /* A `nodecall` is written straight out rather than queued behind the
   * tree's patches: it is a request with someone waiting on it, not a
   * change to the view. */
  setWriter((message) => tty.write(encodeFrame(message)));
  /* `navigate()` called from application code has to move the browser's
   * URL too, or the back button would forget the page ever changed. */
  setNavigator((href) => send({ op: "nav", href }));

  const snapshot = () => {
    live = true;
    /* Anything queued describes a tree the client has not seen; the
     * snapshot below already carries that state. */
    queue = [];
    view(encodeFrame({ op: "mount", title, root: serialize(ROOT) }));
  };

  /* An `ask` is the one thing on this wire that expects an answer,
   * which is what lets a peer that is not a browser — the dev
   * server's HTTP route, an agent — treat the portal as
   * request/response. Everything else is fire-and-forget.
   */
  const answer = async (message) => {
    const reply = (fields) => tty.write(encodeFrame({ op: "answer", id: message.id, ...fields }));
    if (typeof onAsk !== "function") {
      reply({ error: "this app takes no questions", done: true });
      return;
    }
    try {
      const text = await onAsk({
        name: message.name,
        q: message.q ?? "",
        write: (delta) => delta && reply({ delta: String(delta) }),
      });
      reply({ text: String(text ?? ""), done: true });
    } catch (error) {
      reply({ error: String(error?.message ?? error), done: true });
    }
  };

  /* One entry per live stream, so an `unstream` — or a reader that
   * simply went away — can stop the producer. */
  const streaming = new Map();

  tty.on(
    "keydown",
    uplinkReader((message) => {
      switch (message.t) {
        case "hello":
          /* The browser owns the URL, so the first thing it says is
           * where it is. Setting the location before the snapshot
           * means the tree is rendered for the right route once,
           * rather than rendered at `/` and immediately patched. */
          if (message.path) setLocation(message.path);
          snapshot();
          break;
        case "nav":
          setLocation(message.path);
          break;
        case "event":
          dispatch(message);
          break;
        /* Pages registered with `onKey` see it first; the mount option
         * is for an app that wants one handler for everything. */
        case "key":
          if (!dispatchKey(message)) onKey?.(message);
          break;
        case "ask":
          answer(message);
          break;
        /* The hub answering a call this isolate made. */
        case "noderesult":
          settleNode(message);
          break;
        /* Something calling a `"use yeet"` function. The reply is
         * written directly rather than queued: it belongs to one
         * caller, not to the tree every peer shares. */
        /* A stream: many frames under one id, then `done`. Written
         * directly rather than queued — a value is a reply to one
         * reader, not a change to the tree everyone shares. */
        case "stream": {
          const { sid } = message;
          streaming.get(sid)?.();
          streaming.set(
            sid,
            startStream(message.action, message.args ?? [], (frame) => {
              if (!streaming.has(sid)) return;
              tty.write(encodeFrame({ op: "yield", sid, ...frame }));
              if (frame.done || frame.error) streaming.delete(sid);
            }),
          );
          break;
        }
        case "unstream":
          streaming.get(message.sid)?.();
          streaming.delete(message.sid);
          break;
        /* A browser closed. The hub knows which ids were its; the
         * isolate cannot see a socket go away, so it is told. */
        case "unstreamAll":
          for (const [sid, cancel] of streaming) {
            if (String(sid).startsWith(message.owner)) {
              cancel();
              streaming.delete(sid);
            }
          }
          break;
        case "call":
          callAction(message.action, message.args ?? []).then((result) =>
            tty.write(encodeFrame({ op: "return", cid: message.cid, ...result })),
          );
          break;
      }
    }),
  );

  render(code, ROOT);
  return { snapshot };
}

/* `yeet run` tears the isolate down as soon as the module settles, so
 * an app that only reacts to input has to park forever.
 */
export function serve(code, options) {
  const handle = mount(code, options);
  return new Promise(() => handle);
}
