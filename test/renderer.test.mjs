/* The wire renderer, driven directly: no isolate, no socket.
 *
 * Signal writes made inside the body of `createRoot` are batched until
 * the root finishes, so every test sets up under a root and then
 * writes and asserts outside it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoot, createSignal } from "solid-js";

import { ROOT, createElement, insert, serialize, setEmitter, setProp } from "../src/runtime/renderer.js";

test("a function on a native attribute is a reactive getter, not its own source text", () => {
  const patches = [];
  setEmitter((p) => patches.push(p));
  const [on, setOn] = createSignal(false);
  const [h, setH] = createSignal(10);
  let el;
  const dispose = createRoot((d) => {
    el = createElement("span");
    insert(ROOT, el, null);
    setProp(el, "class", () => (on() ? "a lit" : "a"));
    setProp(el, "style", () => ({ height: `${h()}%` }));
    setProp(el, "title", "plain");
    return d;
  });
  assert.equal(serialize(el).attrs.class, "a");
  assert.equal(serialize(el).attrs.style, "height:10%");
  assert.equal(serialize(el).attrs.title, "plain");
  setOn(true);
  setH(42);
  assert.equal(serialize(el).attrs.class, "a lit");
  assert.equal(serialize(el).attrs.style, "height:42%");
  const attrPatches = patches.filter((p) => p.op === "attr" && p.id === el.id).map((p) => `${p.name}=${p.value}`);
  assert.deepEqual(attrPatches.slice(-2), ["class=a lit", "style=height:42%"]);
  setH(42);
  assert.equal(patches.filter((p) => p.op === "attr" && p.id === el.id).length, attrPatches.length, "an unchanged value is not a patch");
  dispose();
});

test("event handlers are still handlers, not getters", () => {
  setEmitter(() => {});
  let el;
  const dispose = createRoot((d) => {
    el = createElement("button");
    insert(ROOT, el, null);
    setProp(el, "onClick", () => {});
    return d;
  });
  assert.deepEqual(el.on, ["click"]);
  assert.equal(serialize(el).attrs.onClick, undefined);
  dispose();
});
