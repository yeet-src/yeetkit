/* `"use server"` functions, in the Node process that runs them.
 *
 * The bundle is imported rather than linked in: it is rebuilt whenever
 * a source file changes, and importing a fresh URL each time is how a
 * long-lived host picks up a new version without restarting. Node
 * caches modules by specifier, so the cache-busting query is the whole
 * trick.
 */

import { pathToFileURL } from "node:url";

import { matchApi } from "./match.mjs";

export function createActions({ log }) {
  let registry = new Map();
  let routes = [];
  let version = 0;

  /* Set by the hub once it exists, and read by the loaded bundle: a
   * `"use server"` module that imports a `"use yeet"` one ends up
   * here, and the call goes out over the same socket. */
  let toIsolate = async () => {
    throw new Error("the isolate is not connected");
  };

  return {
    /** Called by the hub as soon as it can talk to the isolate. */
    useIsolate(fn) {
      toIsolate = fn;
    },

    /* Exposed to the bundle through a global rather than an import,
     * because the bundle is built separately and resolving back into
     * this file from there would mean bundling the host into itself. */
    install() {
      globalThis.__yeetkitCallIsolate = (action, args) => toIsolate(action, args);
    },

    async load(bundlePath) {
      try {
        const url = `${pathToFileURL(bundlePath).href}?v=${++version}`;
        const module = await import(url);
        registry = new Map(Object.entries(module.actions ?? {}));
        routes = module.routes ?? [];
        return registry.size;
      } catch (error) {
        log?.("error", `"use server" bundle failed to load: ${error?.message ?? error}`);
        registry = new Map();
        routes = [];
        return 0;
      }
    },

    /* Errors are returned rather than thrown. The caller is a socket —
     * an isolate waiting on a render, or a browser waiting on a click —
     * and neither can catch an exception raised over here.
     */
    async call(action, args) {
      const fn = registry.get(action);
      if (!fn) return { error: `no "use server" function ${action}` };
      try {
        return { value: await fn(...args) };
      } catch (error) {
        log?.("error", `"use server" ${action}: ${error?.message ?? error}`);
        return { error: String(error?.message ?? error) };
      }
    },

    get size() {
      return registry.size;
    },

    /** What the route table prints, and what `dispatch` matches against. */
    get httpRoutes() {
      return routes;
    },

    /* An HTTP request against `app/**​/route.js`.
     *
     * Returns null when no route claims the path, which is what lets
     * the caller fall through to serving the page shell — every path
     * has to reach the app, so a miss here is not a 404.
     *
     * The handler is handed a real `Request` and is expected to return
     * a real `Response`; both are globals in Node now, and matching the
     * platform means a handler is portable and testable without this
     * framework around it.
     */
    async dispatch(request) {
      const url = new URL(request.url);
      const found = matchApi(routes, url.pathname);
      if (!found) return null;

      const handler = found.route.handlers?.[request.method];
      if (typeof handler !== "function") {
        /* The path exists but not for this verb. Telling that apart
         * from "no such route" is the caller's whole problem. */
        return new Response(`${request.method} not allowed`, {
          status: 405,
          headers: { allow: found.route.methods.join(", ") },
        });
      }

      try {
        const response = await handler(request, { params: found.params });
        if (response instanceof Response) return response;
        /* A handler that returns plain data is a common slip and a
         * cheap one to be kind about. */
        return Response.json(response ?? null);
      } catch (error) {
        log?.("error", `${request.method} ${url.pathname}: ${error?.message ?? error}`);
        return new Response("internal error", { status: 500 });
      }
    },
  };
}
