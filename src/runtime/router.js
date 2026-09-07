/* File-system routing, resolved in the isolate.
 *
 * Routing here is a signal, not a fetch. The browser owns the URL bar
 * and reports it; the isolate holds `location` and re-renders the
 * matched page. There is no navigation request, no route bundle to
 * load, no loading state to design — a click travels up the socket
 * and the patches for the new page come back down, so navigation
 * costs one round trip and touches only the nodes that differ.
 *
 * Routes are generated at build time from the `app/` tree (see
 * `src/cli/routes.mjs`); this module only matches and composes them.
 */

import { createMemo, createRenderEffect, createSignal } from "solid-js";
import { createComponent, createElement, insert, setProp } from "./renderer.js";

const [location, setLocationRaw] = createSignal("/");
const [params, setParams] = createSignal({});

export { location, params };

export const useLocation = location;
export const useParams = params;

/* The path portion of the current location, without query or hash.
 *
 * Deliberately a plain derivation rather than a memo: a memo created
 * at module scope has no owner, never recomputes, and would pin the
 * whole router to the first path it ever saw. Splitting a string on
 * each read costs nothing next to that.
 */
export const usePathname = () => split(location()).path;

function split(href) {
  const hash = href.indexOf("#");
  const clean = hash >= 0 ? href.slice(0, hash) : href;
  const q = clean.indexOf("?");
  return {
    path: q >= 0 ? clean.slice(0, q) : clean,
    query: q >= 0 ? clean.slice(q + 1) : "",
  };
}

/** Called by the transport when the browser reports a new URL. */
export function setLocation(href) {
  setLocationRaw(href || "/");
}

/* Navigation from the isolate side — a redirect after a mutation, say.
 * The browser is told to push the entry so the back button still
 * works; `mount` installs this emitter.
 */
let pushToBrowser = () => {};
export const setNavigator = (fn) => {
  pushToBrowser = fn;
};

export function navigate(href) {
  setLocation(href);
  pushToBrowser(href);
}

const segments = (path) => path.split("/").filter(Boolean);

/* Static beats dynamic beats catch-all, at every depth. Sorting once
 * at match time is cheap and keeps the generated route table free of
 * ordering rules.
 */
function specificity(route) {
  return route.segments.map((s) => (s.kind === "static" ? 2 : s.kind === "param" ? 1 : 0));
}

function better(a, b) {
  const x = specificity(a);
  const y = specificity(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function tryMatch(route, parts) {
  const out = {};

  for (let i = 0; i < route.segments.length; i += 1) {
    const seg = route.segments[i];

    if (seg.kind === "rest") {
      out[seg.name] = parts.slice(i);
      return out;
    }
    if (i >= parts.length) return null;
    if (seg.kind === "static") {
      if (seg.name !== parts[i]) return null;
      continue;
    }
    out[seg.name] = decodeURIComponent(parts[i]);
  }

  return route.segments.length === parts.length ? out : null;
}

export function matchRoute(routes, path) {
  const parts = segments(path);
  for (const route of [...routes].sort(better)) {
    const found = tryMatch(route, parts);
    if (found) return { route, params: found };
  }
  return null;
}

/* Layouts wrap the page from the outside in, and each nesting level
 * is its own reactive boundary. That is the whole reason this is not
 * one memo over the match: if the router rebuilt the composition on
 * every navigation, moving between two pages that share a layout
 * would throw the layout's DOM away — and with it any state it holds,
 * an open menu, a scroll position, a running subscription.
 *
 * Instead, level N re-runs only when the component *at level N*
 * changes. Navigating from `/procs` to `/` changes the page and
 * nothing above it, so the shell is untouched and the patches on the
 * wire describe only the part of the page that differs.
 */
function level(matched, depth) {
  /* Depth by depth: a layout while there are layouts left, then the
   * page. Comparing component identity is what makes a shared layout
   * a no-op. */
  const componentAt = createMemo(() => {
    const { route } = matched();
    return depth < route.layouts.length ? route.layouts[depth] : route.page;
  });

  /* Its own memo rather than a read inside the one below: reading the
   * match directly down there would subscribe this level to every
   * navigation, which is exactly what the split exists to avoid. Both
   * of these settle to unchanged values when a layout is shared, so
   * the memo below never re-runs and its DOM is never touched. */
  const isPageAt = createMemo(() => depth >= matched().route.layouts.length);

  return createMemo(() => {
    const Component = componentAt();
    if (!Component) return null;

    /* Both branches build their props as one literal of getters, and
     * nothing here spreads: spreading an object of getters *calls*
     * them, which would read the match inside this memo and subscribe
     * the level to every navigation — undoing the whole split above.
     *
     * As getters they are read in the child's own reactive context
     * instead, so a page that shows `props.params.id` re-runs just
     * that binding when the segment changes.
     */
    if (isPageAt()) {
      return createComponent(Component, {
        get params() {
          return matched().params;
        },
        get path() {
          return usePathname();
        },
      });
    }

    const below = level(matched, depth + 1);
    return createComponent(Component, {
      get params() {
        return matched().params;
      },
      get path() {
        return usePathname();
      },
      /* The accessor itself, not its value: Solid treats a function
       * child as reactive, so the layout subscribes to the level below
       * it and a page change patches through without the layout being
       * rebuilt. It is lazy too — a layout that only renders
       * `children` inside a `<Show>` does not build the page until it
       * shows it. */
      get children() {
        return below;
      },
    });
  });
}

/* The router is the top of that chain. `matched` is the one signal
 * everything below reacts to.
 */
export function Router(props) {
  const matched = createMemo(() => {
    const found = matchRoute(props.routes ?? [], usePathname());
    if (found) {
      setParams(found.params);
      return found;
    }
    setParams({});
    /* A missing route is still a route: rendering it through the same
     * chain means `not-found` appears inside the layouts it sits
     * under, the way any other page would. */
    const fallback = props.fallback ?? { layouts: [], page: null };
    return { route: fallback, params: {} };
  });

  /* The accessor, for the same reason: whatever inserts the router
   * has to subscribe to it. */
  return level(matched, 0);
}

/* A link is an ordinary anchor: the client intercepts internal hrefs
 * and reports the new URL, so there is no click handler to bind and
 * nothing to send. It exists so application code reads the way it
 * would in any other framework — and so external links, `target`, and
 * modified clicks keep working without a special case, because they
 * are still just an `<a>`.
 *
 * `activeClass` is the one thing it adds: knowing the current route is
 * free here, since the router is a signal in the same process.
 */
export function Link(props) {
  const el = createElement("a");

  createRenderEffect(() => setProp(el, "href", props.href));
  createRenderEffect(() => {
    const path = usePathname();
    const here = props.end ? path === props.href : path.startsWith(props.href);
    setProp(el, "class", [props.class, here && props.activeClass].filter(Boolean).join(" "));
  });
  for (const name of ["target", "rel", "title", "id"]) {
    createRenderEffect(() => props[name] !== undefined && setProp(el, name, props[name]));
  }

  insert(el, () => props.children);
  return el;
}
