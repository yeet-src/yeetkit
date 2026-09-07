/* The browser half: a thin mirror of the tree the isolate holds.
 *
 * It knows nothing about the application. It keeps a map of id ->
 * Node, applies the patches that arrive, sends events back up, and
 * owns the two things the isolate cannot see — the URL bar and the
 * connection itself.
 *
 * The socket is a tty portal, so the framing is asymmetric and
 * deliberately odd: patches come down inside an OSC escape sequence
 * (the only way a payload survives terminal output processing), and
 * events go up as base64url characters, one synthetic `keydown` per
 * character, because the terminal input decoder is what parses this
 * direction and it surfaces nothing else.
 */

const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const nodes = new Map();
let socket = null;
let root = null;

// ---- uplink ---------------------------------------------------------

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
  /* A newline is what the terminal input decoder turns into the
   * `Enter` that terminates a message, and the frame goes as bytes:
   * this direction is parsed as tty input, not as text. */
  return new TextEncoder().encode(`${out}\n`);
}

function up(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeUplink(message));
}

// ---- applying patches -----------------------------------------------

/* Attributes that are only meaningful as live properties: setting
 * `value` as an attribute changes the default, not what the user
 * sees, and would leave a controlled input out of step with the
 * isolate.
 */
const PROPERTIES = new Set(["value", "checked", "selected", "innerHTML", "disabled"]);

function build(spec) {
  if (spec.text !== undefined) {
    const node = document.createTextNode(spec.text);
    node.__yid = spec.id;
    nodes.set(spec.id, node);
    return node;
  }

  const el = document.createElement(spec.tag);
  el.__yid = spec.id;
  nodes.set(spec.id, el);

  for (const [name, value] of Object.entries(spec.attrs ?? {})) setAttr(el, name, value);
  for (const type of spec.on ?? []) listen(spec.id, el, type);
  for (const kid of spec.kids ?? []) el.appendChild(build(kid));

  /* A `"use client"` component. Its server-rendered children are
   * already attached above and are handed to the island as they are —
   * the same nodes, still under the ids the isolate patches by. */
  if (spec.tag === "yeet-island") mountIsland(el);

  return el;
}

/* Islands are optional, so the module is loaded once and only used if
 * the app actually has any. */
let islands = null;

function mountIsland(el) {
  islands?.mount(el, el.getAttribute("data-island"), el.getAttribute("data-props"));
}

function setAttr(el, name, value) {
  if (PROPERTIES.has(name)) {
    el[name] = value ?? (typeof el[name] === "boolean" ? false : "");
    return;
  }
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? "" : String(value));
}

/* Only the fields an isolate can act on are sent up: the whole event
 * object is not serializable, and a handler that needs more than this
 * is asking the wrong side of the wire.
 */
function payloadOf(event) {
  const target = event.target ?? {};
  const out = {
    value: target.value,
    checked: target.checked,
    id: target.id,
    name: target.name,
    dataset: target.dataset ? { ...target.dataset } : undefined,
  };
  if (event instanceof KeyboardEvent) {
    Object.assign(out, {
      key: event.key,
      code: event.code,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    });
  }
  if (event instanceof MouseEvent) {
    Object.assign(out, { x: event.clientX, y: event.clientY, button: event.button });
  }
  return out;
}

const attached = new Map(); // "<id>:<type>" -> the listener, so it can be removed

function listen(id, el, type) {
  const key = `${id}:${type}`;
  if (attached.has(key)) return;

  const handler = (event) => {
    /* A submit that reloads the page would drop the socket, and the
     * isolate has already been told about the event. */
    if (type === "submit") event.preventDefault();
    up({ t: "event", id, type, payload: payloadOf(event) });
  };
  el.addEventListener(type, handler);
  attached.set(key, { el, type, handler });
}

function unlisten(id, type) {
  const key = `${id}:${type}`;
  const found = attached.get(key);
  if (!found) return;
  found.el.removeEventListener(found.type, found.handler);
  attached.delete(key);
}

/* A removed subtree takes its listeners and its ids with it, or a
 * long-lived page grows a map entry for every node it has ever shown.
 * The id is parked on the node so this costs a walk of the subtree
 * being removed rather than a scan of everything on the page — the
 * difference between a list re-render being linear and quadratic.
 */
function forget(node) {
  if (node.tagName === "YEET-ISLAND") islands?.unmount(node);
  const id = node.__yid;
  if (id !== undefined) {
    nodes.delete(id);
    for (const key of [...attached.keys()]) {
      const [owner, type] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (Number(owner) === id) unlisten(id, type);
    }
  }
  for (const kid of node.childNodes ?? []) forget(kid);
}

function apply(patch) {
  switch (patch.op) {
    case "batch":
      for (const one of patch.patches) apply(one);
      return;

    case "mount": {
      document.title = patch.title ?? document.title;
      nodes.clear();
      attached.clear();
      root.replaceChildren();
      nodes.set(0, root);
      for (const kid of patch.root.kids ?? []) root.appendChild(build(kid));
      document.body.dataset.state = "live";
      return;
    }

    case "insert": {
      const parent = nodes.get(patch.parent);
      if (!parent) return;
      const node = build(patch.node);
      const anchor = patch.before === null ? null : nodes.get(patch.before);
      parent.insertBefore(node, anchor ?? null);
      return;
    }

    case "remove": {
      const node = nodes.get(patch.id);
      if (!node) return;
      forget(node);
      node.remove();
      return;
    }

    case "text": {
      const node = nodes.get(patch.id);
      if (node) node.data = patch.value;
      return;
    }

    case "attr": {
      const node = nodes.get(patch.id);
      if (!node) return;
      setAttr(node, patch.name, patch.value);
      /* New props for a live island: handed over rather than
       * remounted, so it keeps the state it holds. */
      if (patch.name === "data-props" && node.tagName === "YEET-ISLAND") mountIsland(node);
      return;
    }

    case "listen": {
      const node = nodes.get(patch.id);
      if (node) listen(patch.id, node, patch.type);
      return;
    }

    case "unlisten":
      unlisten(patch.id, patch.type);
      return;

    /* The isolate redirected. The browser owns history, so it is the
     * one that has to record the move. */
    case "nav":
      if (patch.href !== here()) history.pushState({}, "", patch.href);
      return;

    case "answer":
      window.dispatchEvent(new CustomEvent("yeetkit:answer", { detail: patch }));
      return;

    /* The reply to a call an island made — to the isolate ("use yeet")
     * or to the host ("use server"). Both settle the same way. */
    case "return":
    case "noderesult":
      islands?.settle(patch);
      return;

    /* One value of a STREAM. */
    case "yield":
      islands?.feed(patch);
      return;
  }
}

// ---- the URL bar ----------------------------------------------------

const here = () => location.pathname + location.search;

/* Every internal anchor is a client-side navigation, so application
 * code never has to reach for a special component. The exceptions are
 * the ones a browser would handle differently anyway: another origin,
 * a new tab, a download, or a modified click the user meant as one.
 */
function interceptLinks() {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    if (anchor.target && anchor.target !== "_self") return;
    if (anchor.hasAttribute("download")) return;

    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;

    event.preventDefault();
    const next = url.pathname + url.search;
    if (next !== here()) history.pushState({}, "", next);
    up({ t: "nav", path: next });
  });

  addEventListener("popstate", () => up({ t: "nav", path: here() }));
}

/* Keys that reach no element still reach the app: a keyboard-driven
 * view would otherwise lose every keystroke the moment a live update
 * re-rendered the focused node away.
 */
function forwardKeys() {
  document.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
    up({
      t: "key",
      key: event.key,
      code: event.code,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    });
  });
}

// ---- the socket -----------------------------------------------------

/* Frames arrive as tty bytes, so a payload can be split across
 * messages; the tail is kept until its terminator shows up.
 */
function reader() {
  let pending = "";

  return (chunk) => {
    pending += chunk;

    for (;;) {
      const start = pending.indexOf(OSC_OPEN);
      if (start < 0) {
        /* Nothing framed in here — but the opening sequence may be
         * split across the boundary, so a short tail is kept. */
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
        apply(JSON.parse(body));
      } catch (error) {
        console.error("yeetkit — bad frame", error, body.slice(0, 200));
      }
    }
  };
}

export async function connect(url, mountPoint) {
  root = mountPoint;
  let backoff = 250;

  /* Loaded before the socket, not after: the first frame may already
   * contain islands, and mounting them must not race the import. The
   * module always exists — an app with no `"use client"` gets an empty
   * one — so a failure here is a real failure, not an absence. */
  try {
    const loaded = await import(globalThis.__yeetkitIslands ?? "/@yeetkit/islands.js");
    if (loaded.mount) {
      islands = loaded;
      islands.setTransport(up);
    }
  } catch (error) {
    console.error("yeetkit: island bundle failed to load", error);
  }

  const open = () => {
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const feed = reader();

    socket.addEventListener("open", () => {
      backoff = 250;
      document.body.dataset.state = "connected";
      up({ t: "hello", path: here() });
    });

    socket.addEventListener("message", (event) => {
      feed(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(new Uint8Array(event.data)),
      );
    });

    /* A dropped socket is the normal case in development — the dev
     * server restarts the isolate on every edit — so reconnecting is
     * routine and the reconnect is what asks for a fresh tree.
     */
    socket.addEventListener("close", () => {
      document.body.dataset.state = "reconnecting";
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 4000);
    });
  };

  open();
  interceptLinks();
  forwardKeys();
}

/* Request/response over a channel that has none: an id goes up and one
 * `answer` comes back bearing it. Used by tooling, not by pages.
 */
export function ask(name, q, { onDelta } = {}) {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const onAnswer = (event) => {
      const patch = event.detail;
      if (patch.id !== id) return;
      if (patch.delta) return onDelta?.(patch.delta);
      window.removeEventListener("yeetkit:answer", onAnswer);
      patch.error ? reject(new Error(patch.error)) : resolve(patch.text);
    };
    window.addEventListener("yeetkit:answer", onAnswer);
    up({ t: "ask", id, name, q });
  });
}
