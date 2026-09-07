/* Matching a request path against the collected `route.js` patterns.
 *
 * The same segment rules the page router uses — static beats dynamic
 * beats catch-all — but resolved here, in Node, because these routes
 * answer HTTP rather than render anything. Kept separate from the
 * router so nothing in the host has to import Solid.
 */

const specificity = (route) =>
  route.segments.map((s) => (s.kind === "static" ? 2 : s.kind === "param" ? 1 : 0));

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
  const params = {};

  for (let i = 0; i < route.segments.length; i += 1) {
    const segment = route.segments[i];

    if (segment.kind === "rest") {
      params[segment.name] = parts.slice(i);
      return params;
    }
    if (i >= parts.length) return null;
    if (segment.kind === "static") {
      if (segment.name !== parts[i]) return null;
      continue;
    }
    params[segment.name] = decodeURIComponent(parts[i]);
  }

  return route.segments.length === parts.length ? params : null;
}

/* Returns the route whose path matches, whether or not it has a
 * handler for this method: a path that exists but not for this verb is
 * a 405, and telling those apart is the caller's whole problem.
 */
export function matchApi(routes, path) {
  const parts = path.split("/").filter(Boolean);
  for (const route of [...routes].sort(better)) {
    const params = tryMatch(route, parts);
    if (params) return { route, params };
  }
  return null;
}
