/* Wires a Solid tree to its portals.
 *
 * The isolate opens two named portals, and whoever attaches to one is
 * a peer of its own: what a peer writes is heard from that peer, and
 * what is written to a peer reaches that peer alone.
 *
 *   hub    control. Everything with someone waiting on it — calls and
 *          their replies, streams, `nodecall`, answers — and everything
 *          coming up: events, navigation, keys.
 *   view   data. The tree: the snapshot and every patch. Read only;
 *          whatever a peer sends here is dropped.
 *
 * They are separate so that control never queues behind data. A
 * snapshot of a large page is one large message, and on a shared
 * socket a reply written just after it waits for all of it to drain.
 * On its own socket it does not.
 *
 * Who the peers are is the binding's business, not this file's. By
 * default Node holds both on loopback and re-serves browsers itself.
 * In *direct* mode `view` is bound wide and browsers dial it
 * themselves, while `hub` stays with Node — so the private traffic is
 * never on a socket a browser holds, and a browser is let in to
 * exactly one thing it can only read.
 *
 * A peer attaching says nothing about where its browser is, so the
 * browser still announces itself: the client sends `hello` on open and
 * on every reconnect, with its path, and that — not startup, and not
 * the attach — is what sends the tree. A client that arrives late, or
 * comes back after the isolate restarted, is handed a snapshot of the
 * tree as it stands now.
 *
 * One isolate is one running application shared by every connected
 * browser: there is one tree, and every viewer is written the same
 * patches. Two tabs are two views of the same state, not two sessions.
 * For an instrument — which is what this is for — that is the useful
 * behaviour; it is also the reason there is no per-request rendering
 * anywhere in here.
 */

import { dispatchKey } from "./keys.js";
import { HUB, VIEW, decodeFrame, encodeFrame } from "./protocol.js";
import { ROOT, dispatch, render, serialize, setEmitter } from "./renderer.js";
import { setWriter, settleNode } from "./node.js";
import { callAction, startStream } from "./rpc.js";
import { setLocation, setNavigator } from "./router.js";

/* Opens a portal and keeps the set of peers attached to it, which the
 * portal itself does not hand out. `onMessage` is given each decoded
 * message with the peer that sent it. */
function listen(name, { onMessage, onClose } = {}) {
  const portal = new Portal(name);
  const peers = new Set();

  portal.on("peer", (peer) => {
    peers.add(peer);
    /* Always listened to, even where nothing is expected: unread input
     * is buffered, and a peer whose buffer fills is closed. */
    peer.on("data", (data) => {
      const message = decodeFrame(data);
      if (message) onMessage?.(message, peer);
    });
    peer.on("close", () => {
      peers.delete(peer);
      onClose?.(peer);
    });
  });

  return { portal, peers };
}

/* A peer can close between being chosen and being written to; that is
 * its business, not a reason to take the frame away from the others. */
function write(peer, message) {
  try {
    peer.write(encodeFrame(message));
  } catch {
    // gone
  }
}

function writeAll(peers, message) {
  if (peers.size === 0) return;
  const frame = encodeFrame(message);
  for (const peer of peers) {
    try {
      peer.write(frame);
    } catch {
      // gone
    }
  }
}

export function mount(code, options = {}) {
  const { title = "yeetkit", onKey = null, onAsk = null } = options;

  let live = false;

  /* One entry per live stream, so an `unstream` — or a reader that
   * simply went away — can stop the producer. */
  const streaming = new Map();

  const stop = (sid) => {
    streaming.get(sid)?.cancel();
    streaming.delete(sid);
  };

  /* An `ask` is the one thing on this wire that expects an answer,
   * which is what lets a peer that is not a browser — the dev
   * server's HTTP route, an agent — treat the portal as
   * request/response. Everything else is fire-and-forget.
   */
  const answer = async (message, peer) => {
    const reply = (fields) => write(peer, { op: "answer", id: message.id, ...fields });
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

  /* Everything a peer on the hub portal can say. A reply goes back to
   * the peer that asked and to nobody else. */
  const onHubMessage = (message, peer) => {
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
        answer(message, peer);
        break;
      /* The hub answering a call this isolate made. */
      case "noderesult":
        settleNode(message);
        break;
      /* A stream: many frames under one id, then `done`. Written
       * to the reader rather than queued — a value is a reply to one
       * caller, not a change to the tree everyone shares. */
      case "stream": {
        const { sid } = message;
        stop(sid);
        const cancel = startStream(message.action, message.args ?? [], (frame) => {
          if (streaming.get(sid)?.peer !== peer) return;
          write(peer, { op: "yield", sid, ...frame });
          if (frame.done || frame.error) streaming.delete(sid);
        });
        streaming.set(sid, { cancel, peer });
        break;
      }
      case "unstream":
        stop(message.sid);
        break;
      /* A browser closed. The hub knows which ids were its; the
       * isolate sees the hub's socket, not the browsers behind it, so
       * it is told. */
      case "unstreamAll":
        for (const sid of [...streaming.keys()]) {
          if (String(sid).startsWith(message.owner)) stop(sid);
        }
        break;
      /* Something calling a `"use yeet"` function. */
      case "call":
        callAction(message.action, message.args ?? []).then((result) =>
          write(peer, { op: "return", cid: message.cid, ...result }),
        );
        break;
    }
  };

  const hub = listen(HUB, {
    onMessage: onHubMessage,
    /* A peer that went away takes its streams with it. This one the
     * isolate *can* see, so nobody has to tell it. */
    onClose(peer) {
      for (const [sid, stream] of [...streaming]) {
        if (stream.peer === peer) stop(sid);
      }
    },
  });

  /* Where the tree goes. */
  const viewers = listen(VIEW).peers;
  const view = (message) => writeAll(viewers, message);

  /* Patches are batched per tick. One signal write can drive several
   * bindings and a stream drives one every few milliseconds; sending
   * each as its own frame costs a stringify and a WebSocket message
   * per peer apiece. The queue drains on a microtask, so everything
   * one turn of the event loop produced leaves as a single frame.
   */
  let queue = [];

  const flush = () => {
    const batch = queue;
    queue = [];
    if (batch.length === 0 || !live) return;
    view(batch.length === 1 ? batch[0] : { op: "batch", patches: batch });
  };

  const send = (patch) => {
    if (!live) return;
    if (queue.length === 0) queueMicrotask(flush);
    queue.push(patch);
  };
  setEmitter(send);
  /* A `nodecall` is written straight out rather than queued behind the
   * tree's patches: it is a request with someone waiting on it, not a
   * change to the view. It goes to the hub portal only, which no
   * browser is ever a peer of. */
  setWriter((message) => writeAll(hub.peers, message));
  /* `navigate()` called from application code has to move the browser's
   * URL too, or the back button would forget the page ever changed. */
  setNavigator((href) => send({ op: "nav", href }));

  /* To every viewer, not just the one that said hello: the location is
   * shared, so a tab arriving somewhere else moves the others, and
   * they need the tree that goes with it. */
  function snapshot() {
    live = true;
    /* Anything queued describes a tree the client has not seen; the
     * snapshot below already carries that state. */
    queue = [];
    view({ op: "mount", title, root: serialize(ROOT) });
  }

  render(code, ROOT);
  return { snapshot };
}

/* An open portal already keeps the isolate alive; parking makes that
 * explicit, and gives the entry module something to await.
 */
export function serve(code, options) {
  const handle = mount(code, options);
  return new Promise(() => handle);
}
