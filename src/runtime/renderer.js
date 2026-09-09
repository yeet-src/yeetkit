/* A Solid universal renderer whose target is a WebSocket, not a DOM.
 *
 * Solid's fine-grained reactivity does not care what a "node" is: give
 * `createRenderer` nine primitives and the compiler's output drives
 * whatever they build. Here a node is a plain record with an id, and
 * every mutation Solid makes becomes one patch on the wire. There is
 * no virtual DOM and no diff — a signal write reaches exactly the
 * nodes that read it, which is what makes a remote tree affordable:
 * the number of bytes on the wire is proportional to what changed, not
 * to the size of the page.
 *
 * The browser holds the real DOM and mirrors this tree by id.
 *
 * Detached subtrees are the one subtlety. Solid builds an element and
 * fills it in *before* inserting it into its parent, so most calls
 * arrive while the node is still floating. Emitting those would
 * describe nodes the client has never heard of, so a patch only goes
 * out when the node is reachable from ROOT; an insert into a
 * reachable parent carries the whole serialized subtree with it.
 */

import { createRenderer } from "solid-js/universal";

let nextId = 1;
let emit = () => {};

/* The tree the client mirrors. `mount()` sets the emitter; until it
 * does, every patch is dropped — the snapshot sent on `hello` already
 * carries whatever state the tree reached in the meantime.
 */
export const ROOT = { id: 0, tag: "#root", attrs: {}, kids: [], parent: null };

export const setEmitter = (fn) => {
  emit = fn;
};

/** "<id>:<type>" -> the listener, or [listener, data] as Solid allows. */
const handlers = new Map();

const isText = (node) => node.text !== undefined;

/* Reachability decides whether a mutation is worth a patch. The walk
 * is up the parent chain, which is short — depth of the tree, not its
 * size — and only runs on mutations.
 */
function connected(node) {
  for (let at = node; at; at = at.parent) {
    if (at === ROOT) return true;
  }
  return false;
}

export function serialize(node) {
  if (isText(node)) return { id: node.id, text: node.text };
  return {
    id: node.id,
    tag: node.tag,
    attrs: node.attrs,
    on: node.on ? [...node.on] : undefined,
    kids: node.kids.map(serialize),
  };
}

/* A removed subtree's listeners would otherwise outlive it: a long
 * session that swaps a list a thousand times would keep every dead
 * handler alive.
 */
function forget(node) {
  if (isText(node)) return;
  if (node.on) {
    for (const type of node.on) handlers.delete(`${node.id}:${type}`);
  }
  for (const kid of node.kids) forget(kid);
}

const isEventName = (name) =>
  name.length > 2 && name.startsWith("on") && name[2] === name[2].toUpperCase();

/* Solid passes `style` as an object and `classList` as a map of
 * conditions; the wire carries plain strings, so both are flattened
 * here rather than teaching the client about them.
 */
const styleText = (value) =>
  typeof value === "string"
    ? value
    : Object.entries(value ?? {})
        .filter(([, v]) => v != null && v !== false)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
        .join(";");

/* `class` and `classList` compose: Tailwind puts the static utilities
 * in one and the conditional ones in the other, and the client should
 * only ever see the resulting string.
 */
function recomputeClass(node) {
  const active = Object.entries(node._classList ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  const all = [node._class, ...active].filter(Boolean).join(" ");
  if (all) node.attrs.class = all;
  else delete node.attrs.class;
  return all;
}

export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = createRenderer({
  createElement(tag) {
    return { id: nextId++, tag, attrs: {}, kids: [], parent: null, on: null };
  },

  createTextNode(value) {
    return { id: nextId++, text: String(value), parent: null };
  },

  replaceText(node, value) {
    node.text = String(value);
    if (connected(node)) emit({ op: "text", id: node.id, value: node.text });
  },

  insertNode(parent, node, anchor) {
    node.parent = parent;
    const at = anchor ? parent.kids.indexOf(anchor) : -1;
    if (at >= 0) parent.kids.splice(at, 0, node);
    else parent.kids.push(node);

    if (connected(parent)) {
      emit({
        op: "insert",
        parent: parent.id,
        before: anchor?.id ?? null,
        node: serialize(node),
      });
    }
  },

  removeNode(parent, node) {
    const was = connected(node);
    parent.kids = parent.kids.filter((kid) => kid !== node);
    node.parent = null;
    forget(node);
    if (was) emit({ op: "remove", id: node.id });
  },

  setProperty(node, name, value, prev) {
    if (isEventName(name)) {
      const type = name.slice(2).toLowerCase();
      if (value == null) {
        handlers.delete(`${node.id}:${type}`);
        node.on = node.on?.filter((t) => t !== type) ?? null;
        if (connected(node)) emit({ op: "unlisten", id: node.id, type });
        return;
      }
      handlers.set(`${node.id}:${type}`, value);
      /* The client only attaches a real listener for types it was
       * told about, so an event nobody handles never crosses the
       * wire. */
      if (!node.on?.includes(type)) {
        (node.on ??= []).push(type);
        if (connected(node)) emit({ op: "listen", id: node.id, type });
      }
      return;
    }

    if (name === "class") {
      node._class = value;
      const next = recomputeClass(node);
      if (connected(node)) emit({ op: "attr", id: node.id, name: "class", value: next });
      return;
    }

    if (name === "classList") {
      node._classList = value;
      const next = recomputeClass(node);
      if (connected(node)) emit({ op: "attr", id: node.id, name: "class", value: next });
      return;
    }

    /* `false` travels as a value rather than as a removal. The browser
     * client already treats it as "no attribute", and a target whose
     * properties are typed — a QML mirror, say — needs to see the
     * boolean rather than a deletion it can only read as "default". */
    const out = name === "style" ? styleText(value) : value;
    if (out == null) delete node.attrs[name];
    else node.attrs[name] = out;

    if (connected(node)) emit({ op: "attr", id: node.id, name, value: out ?? null });
  },

  isTextNode: isText,
  getParentNode: (node) => node.parent,
  getFirstChild: (node) => node.kids?.[0],
  getNextSibling(node) {
    const kids = node.parent?.kids ?? [];
    return kids[kids.indexOf(node) + 1];
  },
});

/* Handlers are application code, and an isolate treats an unhandled
 * rejection as fatal — so a throwing click must land in the log, not
 * take the whole app down with it.
 */
export function dispatch({ id, type, payload }) {
  const handler = handlers.get(`${id}:${type}`);
  if (!handler) return;

  const fail = (error) => console.warn(`${type} handler failed: ${error?.message ?? error}`);
  try {
    const out = Array.isArray(handler)
      ? handler[0](handler[1], payload ?? {})
      : handler(payload ?? {});
    if (typeof out?.then === "function") out.then(null, fail);
  } catch (error) {
    fail(error);
  }
}
