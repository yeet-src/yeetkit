/* An HTTP endpoint, for the callers a socket cannot serve.
 *
 * Everything else in this app is rendered over a WebSocket, which is
 * fine for a browser and useless to a webhook, a `curl`, or another
 * service. A `route.js` is the door for those: it runs in Node — the
 * process that holds the listener, and the only one of the three
 * runtimes with `crypto` for checking a signature — and it can import
 * a `"use yeet"` function when it needs something only the isolate can
 * answer.
 *
 *   curl localhost:3000/api/execs
 *   curl -X PATCH  localhost:3000/api/execs -d '{"filter":"node"}'
 *   curl -X PUT    localhost:3000/api/execs -d '{"minPid":1000}'
 *   curl -X POST   localhost:3000/api/execs -d '{"filter":"sh","ms":2000}'
 *   curl -X DELETE localhost:3000/api/execs
 *
 * Each verb has a different job rather than being the same call spelled
 * five ways, because that difference is the only reason to have more
 * than one:
 *
 *   GET     read the settings and what has been caught
 *   PATCH   change part of the settings, leaving the rest
 *   PUT     replace the settings; anything unnamed goes back to default
 *   POST    run a timed capture — the one that is not idempotent
 *   DELETE  forget what has been caught
 *
 * Handlers take a real `Request` and return a real `Response`, so
 * nothing here depends on this framework being underneath it.
 */

import { clear, configure, recentExecs, settings } from "@/lib/exec.js";

/* What a `PUT` with a field missing, and a `DELETE`, fall back to. */
const DEFAULTS = { filter: "", minPid: 0, paused: false };

/* A capture holds the request open, so it is capped: an endpoint that
 * can be asked to block for an hour is a denial of service with extra
 * steps. */
const MAX_CAPTURE_MS = 5000;

const failed = (error) => Response.json({ error }, { status: 503 });
const badJson = () => Response.json({ error: "expected a JSON body" }, { status: 400 });

async function body(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {}; // the caller catches
}

export async function GET() {
  /* Both of these run in the isolate: the call goes out over the same
   * socket the hub already holds. */
  const [{ rows, error }, live] = await Promise.all([recentExecs(), settings()]);

  if (error) return failed(error);
  return Response.json({ settings: live.settings, count: rows.length, execs: rows });
}

/* Partial: whatever is not named keeps its current value. */
export async function PATCH(request) {
  let patch;
  try {
    patch = await body(request);
  } catch {
    return badJson();
  }

  const live = await settings();
  if (live.error) return failed(live.error);

  const result = await configure({ ...live.settings, ...patch });
  if (result.error) return failed(result.error);
  return Response.json({ settings: result.settings });
}

/* Whole: anything not named goes back to its default, so the same
 * request always leaves the same state behind — which is the reason to
 * reach for `PUT` over `PATCH`. */
export async function PUT(request) {
  let next;
  try {
    next = await body(request);
  } catch {
    return badJson();
  }

  const result = await configure({ ...DEFAULTS, ...next });
  if (result.error) return failed(result.error);
  return Response.json({ settings: result.settings });
}

/* A timed capture: narrow the kernel's filter, watch for a moment, put
 * the settings back, and answer with what went past in between. This is
 * the one verb here that is not idempotent — running it twice does two
 * captures — which is what `POST` is for.
 */
export async function POST(request) {
  let options;
  try {
    options = await body(request);
  } catch {
    return badJson();
  }

  const live = await settings();
  if (live.error) return failed(live.error);

  const ms = Math.min(Math.max(Number(options.ms) || 1000, 0), MAX_CAPTURE_MS);

  /* Writing the settings also clears what was collected, so the window
   * starts empty and everything in it matched this filter. */
  const armed = await configure({ ...live.settings, filter: options.filter ?? "" });
  if (armed.error) return failed(armed.error);

  await new Promise((resolve) => setTimeout(resolve, ms));
  const caught = await recentExecs();

  /* Restored even if the read failed: leaving someone else's page
   * filtered would be a strange thing for a GET-shaped tool to do. */
  await configure(live.settings);

  if (caught.error) return failed(caught.error);
  return Response.json({ ms, filter: options.filter ?? "", captured: caught.rows.length, execs: caught.rows });
}

/** Forget what has been caught. The program keeps running. */
export async function DELETE() {
  const result = await clear();
  if (result.error) return failed(result.error);
  return Response.json({ cleared: result.cleared });
}
