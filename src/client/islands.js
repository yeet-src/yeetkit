/* The browser's half of an island.
 *
 * This is the only place in yeetkit where application code runs in the
 * browser, and it exists for the three things the isolate genuinely
 * cannot do: reach the DOM, hold state that belongs to one viewer, and
 * respond without a round trip.
 *
 * The Solid running here is the ordinary DOM one. An island is a real
 * Solid root — its own signals, its own effects, its own lifecycle —
 * mounted into the marker element the server sent.
 */

import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";

const registry = new Map(); // id -> component
const mounted = new WeakMap(); // marker element -> { dispose, setProps }

/** Called by the generated islands entry, once per `"use client"` export. */
export const registerIsland = (id, component) => registry.set(id, component);

/* The uplink is installed by client.js rather than imported, so this
 * module has no opinion about the transport and can be tested without
 * one. */
let send = () => {
  throw new Error("islands: no transport");
};
export const setTransport = (fn) => {
  send = fn;
};

// ---- calling a "use server" action ----------------------------------

let nextCall = 1;
const pending = new Map();

/* A `"use yeet"` function: it runs in the isolate, so the message goes
 * through the hub and on to it. */
export function callServer(action, args) {
  return dispatch("call", action, args);
}

/* A `"use server"` function: it runs in the host, so the hub answers
 * without the isolate being involved at all — one hop, not two. */
export function callNode(action, args) {
  return dispatch("nodecall", action, args);
}

function dispatch(t, action, args) {
  const cid = nextCall++;
  return new Promise((resolve, reject) => {
    pending.set(cid, { resolve, reject });
    send({ t, cid, action, args });
  });
}

// ---- consuming a STREAM ---------------------------------------------

let nextStream = 1;
const open = new Map();

/* An async iterable over frames arriving on the socket.
 *
 * Values are queued rather than dropped when the consumer is slower
 * than the producer, and `return()` — which is what a `break` out of a
 * `for await` calls — tells the other side to stop. That is the part
 * polling cannot express: the producer learns that nobody is listening.
 */
export function streamServer(action, args) {
  const sid = nextStream++;
  const queue = [];
  let waiting = null;
  let finished = false;
  let failure = null;

  const wake = () => {
    if (!waiting) return;
    const resolve = waiting;
    waiting = null;
    resolve();
  };

  open.set(sid, {
    push(value) {
      queue.push(value);
      wake();
    },
    end(error) {
      finished = true;
      failure = error ?? null;
      wake();
    },
  });

  send({ t: "stream", sid, action, args });

  const stop = () => {
    if (!open.has(sid)) return;
    open.delete(sid);
    finished = true;
    send({ t: "unstream", sid });
    wake();
  };

  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          for (;;) {
            if (queue.length > 0) return { value: queue.shift(), done: false };
            if (failure) throw new Error(failure);
            if (finished) return { value: undefined, done: true };
            await new Promise((resolve) => (waiting = resolve));
          }
        },
        async return() {
          stop();
          return { value: undefined, done: true };
        },
        async throw(error) {
          stop();
          throw error;
        },
      };
    },
    cancel: stop,
  };
}

/** Routed here by client.js when a `yield` frame arrives. */
export function feed({ sid, value, done, error }) {
  const stream = open.get(sid);
  if (!stream) return;
  if (error || done) {
    open.delete(sid);
    stream.end(error);
    return;
  }
  stream.push(value);
}

/** Routed here by client.js when a `return` or `noderesult` arrives. */
export function settle({ cid, value, error }) {
  const waiting = pending.get(cid);
  if (!waiting) return;
  pending.delete(cid);
  error ? waiting.reject(new Error(error)) : waiting.resolve(value);
}

/* An action that crossed as a prop arrives as `{$action}`; it has to
 * come back as something the island can simply call. */
function decode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if (value.$action) return (...args) => callServer(value.$action, args);
  if (value.$date) return new Date(value.$date);

  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = decode(item);
  return out;
}

// ---- mounting -------------------------------------------------------

/* Server-rendered children are handed to the island as real DOM nodes
 * rather than re-created, which is what lets `{props.children}` inside
 * a client component hold live server content: the nodes keep the ids
 * the isolate knows them by, so patches to them still land after the
 * island has taken them over.
 */
export function mount(element, id, propsJson) {
  const component = registry.get(id);
  if (!component) {
    console.error(`yeetkit: no island "${id}" — is it exported from a "use client" module?`);
    return;
  }

  const existing = mounted.get(element);
  if (existing) {
    existing.setProps(parse(propsJson));
    return;
  }

  const slot = document.createDocumentFragment();
  while (element.firstChild) slot.appendChild(element.firstChild);

  /* Props are a signal so the server can update them without the
   * island being torn down and losing its state. */
  let setProps;
  const dispose = render(() => {
    /* `equals: false` because the server sends a fresh object each
     * time; comparing them would drop every update. */
    const [props, update] = createSignal(parse(propsJson), { equals: false });
    setProps = update;
    return createComponent(component, propsProxy(props, slot));
  }, element);

  mounted.set(element, { dispose, setProps: (next) => setProps?.(next) });
}

export function unmount(element) {
  const found = mounted.get(element);
  if (!found) return;
  found.dispose();
  mounted.delete(element);
}

const parse = (json) => {
  try {
    return decode(JSON.parse(json || "{}"));
  } catch {
    return {};
  }
};

/* A Proxy, and it is never spread: spreading would read every key once
 * and hand the component a snapshot, which is exactly how a live prop
 * turns into a value frozen at mount. Read through it instead and an
 * island sees `props.label` update when the server sends a new one —
 * the ordinary Solid contract.
 */
function propsProxy(props, slot) {
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === "children") return slot.childNodes.length > 0 ? slot : undefined;
        return props()[key];
      },
      has: (_, key) => key === "children" || key in props(),
      ownKeys: () => [...Reflect.ownKeys(props()), "children"],
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    },
  );
}
