/* The isolate's half of an island.
 *
 * A `"use client"` component never runs here. In its place the server
 * renders a marker element carrying the island's id and its props, and
 * the browser mounts the real component into it. Everything the server
 * put inside the marker stays server-owned: those nodes keep their ids,
 * so the isolate can still patch them even after the island has picked
 * them up as `props.children`.
 *
 * The props are the boundary, and it is a real one — the same one RSC
 * has. They are JSON, because they cross a socket. The one exception is
 * a `"use server"` function, which crosses as its id and comes back on
 * the other side as something callable.
 */

import { createRenderEffect } from "solid-js";

import { createElement, insert, setProp } from "./renderer.js";
import { idOf } from "./rpc.js";

/* Deliberately loud. A function or a class instance in props is the
 * mistake people actually make, and the failure is otherwise a silent
 * `null` appearing in the browser hours later.
 */
function encode(value, path = "props") {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "function": {
      const action = idOf(value);
      if (action) return { $action: action };
      throw new Error(
        `${path} is a function. Only a "use server" export can cross to an island — ` +
          `everything else has to be data.`,
      );
    }
    case "object": {
      if (Array.isArray(value)) return value.map((item, i) => encode(item, `${path}[${i}]`));
      if (value instanceof Date) return { $date: value.toISOString() };
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`${path} is a ${value.constructor?.name ?? "class instance"}; islands take plain data.`);
      }
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "children") continue; // rendered as real nodes, not serialized
        out[key] = encode(item, `${path}.${key}`);
      }
      return out;
    }
    default:
      throw new Error(`${path} is a ${typeof value} and cannot cross to an island.`);
  }
}

/* What a `"use client"` import resolves to on this side. The build
 * generates one of these per export. */
export function island(id) {
  return (props) => {
    const el = createElement("yeet-island");
    setProp(el, "data-island", id);

    /* Inside a render effect, because this is hand-written rather than
     * compiled JSX: passing a thunk to `setProp` would store the
     * function itself. Wrapping it means a prop that reads a signal
     * stays live — the server re-sends the props and the client hands
     * them to the running island without tearing it down. */
    createRenderEffect(() =>
      setProp(el, "data-props", JSON.stringify(encode(withoutChildren(props)))),
    );

    if (props.children !== undefined) insert(el, () => props.children);
    return el;
  };
}

function withoutChildren(props) {
  const out = {};
  for (const key of Object.keys(props)) {
    if (key !== "children") out[key] = props[key];
  }
  return out;
}
