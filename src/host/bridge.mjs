/* The hub: Node in the middle.
 *
 *   browser <-ws-> node <-ws-> isolate
 *
 * The isolate's portal is a tty, and a tty is a broadcast — everything
 * on it reaches every peer. So Node takes the portal for itself, binds
 * it to loopback, and becomes the only peer there is. Browsers connect
 * to this process instead, and what they receive is what the hub
 * decides to pass on.
 *
 * That is what makes a private channel possible at all. A `nodecall`
 * frame from the isolate is consumed here and forwarded to nobody; the
 * arguments of a `"use server"` call never reach a browser, even
 * though the isolate wrote them to a broadcast.
 *
 * Three kinds of traffic pass through:
 *
 *   view      patches down, events up — relayed untouched, which is
 *             why the browser client did not have to change beyond
 *             the address it dials.
 *   nodecall  the isolate asking the host to run a `"use server"`
 *             function. Consumed here, answered on the uplink.
 *   yeetcall  the host asking the isolate to run a `"use yeet"` one.
 *             Sent up, and its `return` frame is caught on the way
 *             back rather than relayed.
 */

import { WebSocketServer } from "ws";

const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* Every request that crosses to the isolate is tagged with who asked,
 * because the way back is a broadcast and the reply belongs to one
 * caller.
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

const encodeFrame = (message) => `${OSC_OPEN}${ascii(JSON.stringify(message))}${OSC_CLOSE}`;

function ascii(json) {
  let out = "";
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    out += code > 0x7e ? `\\u${code.toString(16).padStart(4, "0")}` : json[i];
  }
  return out;
}

function encodeUplink(message) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  let out = "";
  let bits = 0;
  let width = 0;

  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    width += 8;
    while (width >= 6) {
      width -= 6;
      out += B64[(bits >> width) & 0x3f];
    }
  }
  if (width > 0) out += B64[(bits << (6 - width)) & 0x3f];
  return new TextEncoder().encode(`${out}\n`);
}

function decodeUplink(text) {
  const bytes = [];
  let bits = 0;
  let width = 0;
  for (const character of text) {
    const value = B64.indexOf(character);
    if (value < 0) continue;
    bits = (bits << 6) | value;
    width += 6;
    if (width >= 8) {
      width -= 8;
      bytes.push((bits >> width) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/* Frames arrive as tty bytes and can be split across messages. */
function framer(onFrame) {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    for (;;) {
      const start = pending.indexOf(OSC_OPEN);
      if (start < 0) {
        pending = pending.slice(-OSC_OPEN.length);
        return;
      }
      const end = pending.indexOf(OSC_CLOSE, start);
      if (end < 0) {
        pending = pending.slice(start);
        return;
      }
      const body = pending.slice(start + OSC_OPEN.length, end);
      pending = pending.slice(end + OSC_CLOSE.length);
      try {
        onFrame(JSON.parse(body));
      } catch {
        // A torn frame is dropped rather than fatal.
      }
    }
  };
}

export function createHub({ isolateUrl, server, path = "/@yeetkit/ws", actions, log }) {
  const browsers = new Set();

  let socket = null;
  let ready = false;
  const outbox = []; // uplink messages waiting for the isolate to come back

  let nextHostCall = 1;
  const hostCalls = new Map();

  let nextBrowser = 1;
  const byNumber = new Map(); // browser number -> its socket

  // ---- to the isolate ------------------------------------------------

  const toIsolate = (message) => {
    if (ready && socket?.readyState === 1) socket.send(encodeUplink(message));
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
    const bytes = encodeFrame(frame);
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
          browser.send(encodeFrame({ ...frame, [key]: coerce(tagged[2]) }));
        }
        return;
      }
    }

    toBrowsers(frame);
  };

  const connect = () => {
    socket = new WebSocket(isolateUrl);
    socket.binaryType = "arraybuffer";
    const feed = framer(onIsolateFrame);

    socket.addEventListener("open", () => {
      ready = true;
      for (const message of outbox.splice(0)) socket.send(encodeUplink(message));
      /* A browser that was already here when the isolate restarted is
       * still waiting on a tree; asking on its behalf is what makes a
       * restart invisible to it. */
      if (browsers.size > 0) toIsolate({ t: "hello", path: "/" });
    });

    socket.addEventListener("message", (event) => {
      feed(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(new Uint8Array(event.data)),
      );
    });

    socket.addEventListener("close", () => {
      ready = false;
      /* The isolate restarts on every edit in development, so this is
       * the normal case rather than an error. */
      setTimeout(connect, 300);
    });

    socket.addEventListener("error", () => {});
  };

  connect();

  // ---- browsers ------------------------------------------------------

  const wss = new WebSocketServer({ server, path });

  wss.on("connection", (browser) => {
    browsers.add(browser);
    const number = nextBrowser++;
    byNumber.set(number, browser);

    let pending = "";
    browser.on("message", async (data) => {
      pending += data.toString();

      for (;;) {
        const at = pending.indexOf("\n");
        if (at < 0) return;
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(decodeUplink(line));
        } catch {
          continue;
        }

        /* An island calling a `"use server"` function. Answered here,
         * to this browser alone — the isolate is not involved and the
         * other tabs never see it. */
        if (message.t === "nodecall") {
          const result = await actions.call(message.action, message.args ?? []);
          if (browser.readyState === 1) {
            browser.send(encodeFrame({ op: "noderesult", cid: message.cid, ...result }));
          }
          continue;
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

  log?.("kit", `hub on ${path} — isolate at ${isolateUrl}`);

  return {
    callIsolate,
    /* Used by the dev server to tell every browser to reload. */
    browsers,
    close() {
      for (const browser of browsers) browser.close();
      wss.close();
      socket?.close();
    },
  };
}
