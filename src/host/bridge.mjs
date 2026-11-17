/* The hub: Node in the middle.
 *
 *   browser <-ws-> node <-ws-> isolate
 *
 * The isolate opens a named portal, `hub`, and Node binds it to
 * loopback and becomes the only peer on it. Browsers connect to this
 * process instead, and what they receive is what the hub decides to
 * pass on.
 *
 * That is what keeps the private channel private. A `nodecall` frame
 * from the isolate is consumed here and forwarded to nobody; the
 * arguments of a `"use server"` call never reach a browser, because
 * no browser is ever a peer of the portal they are written to.
 *
 * Three kinds of traffic pass through:
 *
 *   view      patches down, events up — relayed untouched. In direct
 *             mode the patches skip this process: browsers dial the
 *             isolate's `view` portal for them.
 *   nodecall  the isolate asking the host to run a `"use server"`
 *             function. Consumed here, answered on the same socket.
 *   yeetcall  the host asking the isolate to run a `"use yeet"` one.
 *             Sent up, and its `return` frame is caught on the way
 *             back rather than relayed.
 *
 * Both sockets carry one JSON message per WebSocket message, as text.
 */

import { WebSocketServer } from "ws";

/* Every request that crosses to the isolate is tagged with who asked.
 * The isolate replies to the peer that asked — but every browser is
 * behind the same peer, this one, and the reply belongs to one of
 * them.
 *
 * It also fixes a collision that is easy to miss: each browser counts
 * its own ids from 1, so two tabs both have a `cid: 1` in flight. The
 * hub rewrites them on the way out and restores them on the way back,
 * so a browser never sees an id it did not choose — and never sees
 * another browser's reply at all.
 */
const HOST_CID = "h:";
const BROWSER_CID = /^b(\d+):(.*)$/;

/* Ids survive the round trip as strings; a browser that sent a number
 * should get a number back, or its own map lookup misses. */
const coerce = (text) => (/^\d+$/.test(text) ? Number(text) : text);

const encode = (message) => JSON.stringify(message);

const decode = (data) => {
  try {
    return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
  } catch {
    return null; // not a message; dropped rather than fatal
  }
};

/* Where the isolate's two portals are bound, and how Node reaches
 * them — in one place, because `dev`, `start` and the checks all have
 * to agree with the names the runtime opens.
 *
 * Both sit on the loopback port by default, told apart by path. In
 * direct mode `view` moves to its own port, bound wide, and `viewUrl`
 * is null: the tree does not pass through Node at all.
 */
export function lanes({ wsPort, direct = false, viewPort = wsPort + 1 }) {
  const hub = `127.0.0.1:${wsPort}/hub`;
  const view = direct ? `0.0.0.0:${viewPort}/view` : `127.0.0.1:${wsPort}/view`;
  return {
    args: ["-p", `hub:ws://${hub}`, "-p", `view:ws://${view}`],
    isolateUrl: `ws://${hub}`,
    viewUrl: direct ? null : `ws://${view}`,
  };
}

/* One reconnecting socket to a portal. The isolate restarts on every
 * edit in development, and its listener answers 502 until the script
 * has opened the name, so a refused or dropped socket is the normal
 * case rather than an error. */
function dial(url, { onOpen, onFrame, onClose }) {
  let socket = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener("open", () => onOpen?.());
    ws.addEventListener("message", (event) => {
      const frame = decode(event.data);
      if (frame) onFrame(frame);
    });
    ws.addEventListener("close", () => {
      onClose?.();
      setTimeout(connect, 300);
    });
    ws.addEventListener("error", () => {});
  };
  connect();

  return {
    get open() {
      return socket?.readyState === 1;
    },
    send: (message) => socket.send(encode(message)),
    close() {
      closed = true;
      socket?.close();
    },
  };
}

/* `isolateUrl` is the isolate's `hub` portal: control. `viewUrl` is its
 * `view` portal: the tree. They are two sockets so a reply never waits
 * behind a snapshot. In direct mode `viewUrl` is null — browsers dial
 * that portal themselves and the tree does not come through here. */
export function createHub({ isolateUrl, viewUrl = null, server, path = "/@yeetkit/ws", actions, log }) {
  const browsers = new Set();

  const outbox = []; // uplink messages waiting for the isolate to come back
  /* Where the browsers last said they were, for asking again on their
   * behalf when the isolate comes back. */
  let lastPath = "/";

  let nextHostCall = 1;
  const hostCalls = new Map();

  let nextBrowser = 1;
  const byNumber = new Map(); // browser number -> its socket

  // ---- to the isolate ------------------------------------------------

  const toIsolate = (message) => {
    if (control.open) control.send(message);
    else outbox.push(message);
  };

  /* Calling a `"use yeet"` function from Node. The isolate replies with
   * an ordinary `return` frame, which is caught below rather than
   * relayed on to browsers. */
  const callIsolate = (action, args) => {
    const cid = `${HOST_CID}${nextHostCall++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        hostCalls.delete(cid);
        reject(new Error(`"use yeet" ${action} timed out`));
      }, 30_000);
      hostCalls.set(cid, { resolve, reject, timer });
      toIsolate({ t: "call", cid, action, args });
    });
  };

  // ---- from the isolate ----------------------------------------------

  const toBrowsers = (frame) => {
    const bytes = encode(frame);
    for (const browser of browsers) {
      if (browser.readyState === 1) browser.send(bytes);
    }
  };

  const onIsolateFrame = async (frame) => {
    /* The isolate asking the host to run something. Never forwarded:
     * this is the frame whose arguments must not reach a browser. */
    if (frame.op === "nodecall") {
      const result = await actions.call(frame.action, frame.args ?? []);
      toIsolate({ t: "noderesult", cid: frame.cid, ...result });
      return;
    }

    /* A reply to something *this process* asked for. */
    if (frame.op === "return" && String(frame.cid).startsWith(HOST_CID)) {
      const waiting = hostCalls.get(frame.cid);
      if (waiting) {
        hostCalls.delete(frame.cid);
        clearTimeout(waiting.timer);
        frame.error ? waiting.reject(new Error(frame.error)) : waiting.resolve(frame.value);
      }
      return;
    }

    /* A reply, or one value of a stream, belonging to one browser. */
    if (frame.op === "return" || frame.op === "yield") {
      const key = frame.op === "yield" ? "sid" : "cid";
      const tagged = BROWSER_CID.exec(String(frame[key]));
      if (tagged) {
        const browser = byNumber.get(Number(tagged[1]));
        if (browser?.readyState === 1) {
          /* The id the browser chose, not the one the hub sent. */
          browser.send(encode({ ...frame, [key]: coerce(tagged[2]) }));
        }
        return;
      }
    }

    toBrowsers(frame);
  };

  /* `hello` is what makes the isolate write the tree, and it writes
   * it to whoever is on `view` at that moment — so a hello sent before
   * the view socket is up is a tree sent to nobody. It is held until
   * both are open, and repeated when either comes back: a browser that
   * was already here when the isolate restarted is still waiting on a
   * tree, and asking on its behalf is what makes a restart invisible
   * to it. */
  const viewReady = () => viewUrl === null || tree.open;
  let helloOwed = false;

  const hello = () => {
    if (!control.open || !viewReady()) {
      helloOwed = true;
      return;
    }
    helloOwed = false;
    control.send({ t: "hello", path: lastPath });
  };

  const control = dial(isolateUrl, {
    onOpen() {
      for (const message of outbox.splice(0)) control.send(message);
      if (helloOwed || browsers.size > 0) hello();
    },
    onFrame: onIsolateFrame,
  });

  /* Nothing on this socket is addressed to anyone: it is the tree, and
   * every browser gets it. */
  const tree = viewUrl
    ? dial(viewUrl, {
        onOpen() {
          if (helloOwed || browsers.size > 0) hello();
        },
        onFrame: toBrowsers,
      })
    : null;

  // ---- browsers ------------------------------------------------------

  const wss = new WebSocketServer({ server, path });

  wss.on("connection", (browser) => {
    browsers.add(browser);
    const number = nextBrowser++;
    byNumber.set(number, browser);

    browser.on("message", async (data) => {
      const message = decode(data.toString());
      if (!message) return;

      /* An island calling a `"use server"` function. Answered here,
       * to this browser alone — the isolate is not involved and the
       * other tabs never see it. */
      if (message.t === "nodecall") {
        const result = await actions.call(message.action, message.args ?? []);
        if (browser.readyState === 1) {
          browser.send(encode({ op: "noderesult", cid: message.cid, ...result }));
        }
        return;
      }

      if (message.t === "hello" || message.t === "nav") {
        if (message.path) lastPath = message.path;
        if (message.t === "hello") {
          hello();
          return;
        }
      }

      /* Anything with a reply gets tagged so the reply can find its
       * way back to this socket and no other. `hello`, `event`,
       * `nav` and `key` have no reply and are forwarded as they are. */
      if (message.cid !== undefined) {
        toIsolate({ ...message, cid: `b${number}:${message.cid}` });
      } else if (message.sid !== undefined) {
        toIsolate({ ...message, sid: `b${number}:${message.sid}` });
      } else {
        toIsolate(message);
      }
    });

    browser.on("close", () => {
      browsers.delete(browser);
      byNumber.delete(number);
      /* A closed tab's streams have nobody left to read them, and the
       * isolate has no way to notice on its own. */
      toIsolate({ t: "unstreamAll", owner: `b${number}:` });
    });
  });

  log?.("kit", `hub on ${path} — isolate at ${isolateUrl}${viewUrl ? `, view at ${viewUrl}` : ""}`);

  return {
    callIsolate,
    /* Used by the dev server to tell every browser to reload. */
    browsers,
    close() {
      for (const browser of browsers) browser.close();
      wss.close();
      control.close();
      tree?.close();
    },
  };
}
