# yeetkit

SolidJS + Tailwind apps that run **inside a yeet isolate** and render into
the browser over the tty portal.

The framework is Next-shaped on the outside — `app/` directory, file-system
routes, nested layouts, `yeetkit dev` — and something else entirely on the
inside. Your components never reach the browser. They execute on the host,
next to the kernel data they are displaying, and what crosses the wire is
the handful of DOM mutations Solid's reactivity says are necessary.

```sh
npm i -g --prefix ~/.local /home/jrg/src/yeetkit    # once
yeetkit new dashboard
cd dashboard
npm install          # links the framework; ~1s, no download
npm run dev          # http://localhost:3000
```

The global install is a symlink to the checkout, so edits to the framework
take effect with no reinstall, and `--prefix ~/.local` keeps it out of
`/usr` — no root. Without installing at all, `npx /path/to/yeetkit new
dashboard` does the same thing.

Inside a project, `npm install` puts `yeetkit` on that project's own PATH,
so `npm run dev`, `npm run build` and `npm run check` work from there.
Needs `node` and `yeet` on `PATH`.

## The idea

`yeet run -p tty:ws://0.0.0.0:3001 app.js` starts an isolate and redirects
its tty to a WebSocket. That is the whole transport. The notebook uses it to
put model-written instruments on a page; yeetkit uses it to put an
application there.

```
  browser              node (the hub)              isolate
  ┌────────────┐       ┌──────────────────┐        ┌──────────────────┐
  │ 11kb client│◀─ws──▶│ "use server"     │◀─ws───▶│ your pages       │
  │ islands    │       │  fs fetch npm    │        │ "use yeet"       │
  │ "use client"│      │ tailwind, esbuild│        │ graph bpf ai     │
  └────────────┘       │ static files     │        └──────────────────┘
                       └──────────────────┘
```

Node sits in the middle. It terminates the isolate's portal — which is a
tty, and therefore a broadcast — and re-serves browsers itself, so it
decides what they ever see. That is what makes a private channel possible:
a `"use server"` call's arguments cross the portal but are consumed by the
hub and forwarded to nobody. It also means the isolate binds to loopback
and a browser never touches it.


Solid does not require a DOM. Its `universal` renderer takes nine
primitives — create an element, insert a node, set a property — and
`babel-preset-solid` compiles JSX directly into calls on them. Point those
primitives at a socket instead of `document` and a `createSignal` write on
the host becomes one `{op:"text"}` on the wire. No virtual DOM, no diff, no
hydration: the bytes are proportional to what changed.

Clicking the counter in the template sends one event up and produces
exactly one patch back.

## Direct

An isolate has two lanes out, not one. The tty is the portal above:
bidirectional, and the only lane with an input side. The console lane is
`console.log`, it only goes out, and it can be bound to its own WebSocket
just the same. `direct: true` in `yeetkit.config.js` — or `--direct` on
the command line — splits the traffic across them:

```
  browser ◀── console:ws://0.0.0.0:3002 ──────────── isolate   the view
  browser ──▶ node hub ──▶ tty:ws://127.0.0.1:3001    isolate   events, hello
  node    ◀─▶ tty:ws://127.0.0.1:3001 ◀─────────────▶ isolate   nodecall, return, yield
```

The snapshot and every patch leave the isolate as one console line per
frame and the browser dials that lane itself, so Node is out of the
render path. Everything else is unchanged: events go up through the hub
because the console lane cannot carry them, and `"use server"` calls and
per-caller replies stay on the tty, where the hub is still the only
peer. Nothing has to be banned, and `yeetkit check` asserts that a
direct build's view arrives on the console lane and not on the tty.

The page dials `ws://<its own host>:<console port>/`, which defaults to
`ws + 1`; set `console:` to move it. The console lane has no PTY, so the
frame needs no terminal escaping and arrives intact — but it is
*dedicated* to the wire now: anything the app itself `console.log`s
rides the same socket to every browser. The dev server taps the lane
and prints those lines back to its own log, minus the frames, so a
debugging line still shows up in the terminal; just know that it also
showed up on the wire. And a page served over `https` cannot open a
plain `ws://` socket, so in production the console port needs TLS in
front of it or this stays a LAN feature.

## Why bother

Because the data is on the host and nowhere else. An isolate has no
`fetch`, no `TextEncoder`, no `URL` — it has plain JavaScript and the
`yeet:*` builtins. That sounds like a limitation until you notice what it
removes: there is no API layer to write, because the component *is* on the
server.

```jsx
import { Index, createSignal, onCleanup } from "yeetkit";

export default function Procs() {
  const [rows, setRows] = createSignal([]);

  const tick = async () => {
    const { data } = await yeet.graph.query(
      `{ procs { pid stat { comm rss_bytes } } }`,
    );
    setRows(data.procs.slice(0, 12));
  };

  tick();
  const timer = setInterval(tick, 1000);
  onCleanup(() => clearInterval(timer));

  return (
    <Index each={rows()}>
      {(row) => <tr><td>{row().pid}</td><td>{row().stat.comm}</td></tr>}
    </Index>
  );
}
```

`yeet.graph` is the daemon's system graph — a GraphQL-ish query over
`/proc`, available as a global because the component is already running on
the machine it is measuring.

No route handler, no serializer, no client cache, no polling endpoint. A
1Hz sample of the process table sends only the cells whose numbers moved —
though that last part is a property of how you write the list, not a
freebie. `<For>` keys by item identity, and a fresh sample builds fresh
objects, so it would discard every row each tick and send twelve new
subtrees. `<Index>` keys by position and hands down an accessor, which is
what turns a re-sample into a handful of text patches. `yeetkit check`
asserts the difference, because both look identical on screen.

## Conventions

```
app/
  layout.jsx            wraps everything below it
  page.jsx              /
  globals.css           your theme; Tailwind is imported for you
  not-found.jsx         the fallback, rendered inside its layouts
  about/page.jsx        /about
  procs/[pid]/page.jsx  /procs/:pid          props.params.pid
  docs/[...path]/page.jsx  /docs/*           props.params.path (an array)
  (marketing)/page.jsx  /                    parens group without routing
public/                 served as-is
yeetkit.config.js       optional; title, port, ws, direct, console
```

Two aliases, the same ones a `yeet new` project uses:

| | |
|---|---|
| `@/` | the app root — `import { fmt } from "@/lib/format.js"` |
| `#/` | the linked BPF objects — `import program from "#/app.bpf.o"` |

`@/` saves counting `../`. `#/` is worth more than that: the real path is a
build artifact's, and nothing in `app/` should have to know the build's
layout. Both are resolved by the bundler and listed in `tsconfig.json` so
the editor follows them too.

A page gets `params` and `path`. A layout gets those plus `children`.
`<Link href>` is an ordinary anchor with an optional `activeClass` — the
client intercepts internal clicks, so plain `<a href>` works too.

Routing is a signal in the isolate, not a request. Navigating from
`/procs` to `/` re-runs the page and *nothing above it*: the layout keeps
its DOM, and with it any state it holds. `/procs/1` to `/procs/2` patches
one text node.

## Directives

Everything runs in the isolate by default. Three directives move it, and
they do not mean quite what they mean in Next — because the default is
inverted here.

```jsx
// app/lib/Filter.jsx
"use client";              // runs in the BROWSER: own Solid, own state
import { createSignal } from "solid-js";
import { uptime } from "./actions.js";

export default function Filter(props) {
  const [open, setOpen] = createSignal(true);        // no round trip
  return (
    <div>
      <button onClick={() => setOpen(!open())}>toggle</button>
      <button onClick={async () => console.log(await uptime())}>ask the host</button>
      <div style={{ display: open() ? "block" : "none" }}>{props.children}</div>
    </div>
  );
}
```

```js
// app/lib/actions.js
"use server";              // stays in the isolate; callable from an island
export async function uptime() {
  const { data } = await yeet.graph.query(`{ procs { pid } }`);
  return data.procs.length;
}
```

**`"use client"`** is an island: a real Solid root in the browser, with its
own state and its own event handling. Use it for the three things the
isolate cannot do — reach the DOM, hold state that belongs to one viewer,
or respond without a round trip. It costs about 15kb, and only if you use
one.

**`"use server"`** runs in the **Node** process — `fs`, `fetch`, npm, a
database driver, a native binding. Neither of the other two runtimes has
any of that. It is also the only one whose body never travels: the isolate
and the browser both get a stub, so this is where a secret goes.

**`"use yeet"`** runs in the isolate, next to `yeet.graph`, `yeet:bpf` and
`yeet:ai`. It is the default for pages, so the directive is for *functions*
you want callable from elsewhere — a page calls one directly in the same
process at no cost, while an island or the host reaches it over the socket.
It doubles as enforcement: the build fails if the browser bundle ever
reaches one, and an `import` of `yeet:*` from an island fails the same way.

They compose. A `"use server"` function can import a `"use yeet"` one and
call it — that compiles to a request over the socket the hub already holds
— so one function can read a file *and* the process table:

```js
"use server";
import { readFile } from "node:fs/promises";
import { processCount } from "./host.js";   // "use yeet"

export async function snapshot() {
  return {
    project: JSON.parse(await readFile("package.json", "utf8")).name,  // node
    processes: await processCount(),                                    // isolate
  };
}
```

### Streams

Export an async generator and it is reachable as a **stream** — many values,
pushed, cancellable:

```js
"use yeet";
export async function* tail() {
  try {
    for (;;) yield await nextEvent();
  } finally {
    /* runs when the reader goes away */
  }
}
```

```jsx
// in a page (same process — no wire at all)
for await (const row of tail()) setRows((r) => [row, ...r]);
```

The build tells a generator from a function by looking at the AST, so the
stub on the far side is the right shape without anything being evaluated.

Two things a poll cannot do. Values arrive **when the producer has them**
rather than up to an interval late — which is the whole point for something
like a ring buffer, where the kernel already knows. And a stream is
**cancelled**: `break` out of a `for await`, or close the tab, and the
generator's `finally` runs. Without that a closed tab leaves a producer
running for the life of the isolate.

A stream is per-reader. Two tabs each get their own, and each numbers its
own ids from 1 — the hub rewrites them on the way out and restores them on
the way back, so a browser never sees another browser's values. `yeetkit
check` asserts exactly that, with two sockets deliberately using the same
id.

`"use server"` cannot consume one: the host has no reader to hand values to,
and a stream of kernel events belongs to an isolate function. Trying is a
clear error rather than a hang.

### Which runtime am I in

| | `"use client"` | `"use server"` | `"use yeet"` (default) |
|---|---|---|---|
| runs in | browser | node | isolate |
| `fs`, `fetch`, npm | ✗ | ✓ | ✗ |
| `yeet.graph`, `bpf`, `ai` | ✗ | via a `"use yeet"` call | ✓ |
| DOM, per-viewer state | ✓ | ✗ | ✗ |
| body ships to the browser | ✓ | ✗ | ✗ |
| called from a page | marker | one hop | free, same process |

### The props boundary

Island props are data, because they cross a socket — strings, numbers,
booleans, arrays, plain objects, `Date`, and `"use server"` functions.
Anything else throws with the path that broke (`props.onSave is a
function…`) rather than arriving as `null` an hour later.

Children are different: they stay server-rendered. The isolate's nodes are
handed to the island as live DOM, keeping the ids the isolate patches them
by — so a server-updated value goes on updating inside a client component
that is deciding whether to show it.

## Tailwind

Runs entirely on the host, at build time, and scans `app/` the way it would
any other project. The isolate emits class names as ordinary attribute
values, so every Tailwind feature works unmodified — arbitrary values,
variants, `@apply`, a `@theme` block in `app/globals.css`. The isolate never
sees CSS.

`@import "tailwindcss"` is added for you (your project has no
`node_modules` to resolve it from), so `globals.css` is just your theme.

## HTTP routes

Everything else in a yeetkit app is rendered over a socket, which is fine
for a browser and useless to a webhook, a `curl`, or another service.
`app/**/route.js` is the door for those. Handlers run in **Node** — the
process that holds the listener, and the only runtime with the `crypto` a
signature check needs — and they can import a `"use yeet"` function when
they want something only the isolate can answer.

```js
// app/api/execs/route.js
import { configure, recentExecs } from "@/lib/exec.js";   // "use yeet"

export async function GET() {
  const { rows } = await recentExecs();                   // runs in the isolate
  return Response.json({ execs: rows });
}

export async function PATCH(request) {
  const patch = await request.json();
  return Response.json(await configure(patch));           // writes a BPF map
}
```

Export a function per method — `GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
`DELETE`, `OPTIONS`. Handlers take a real `Request` and return a real
`Response`, so one is portable and testable without this framework
underneath it; return plain data and it is wrapped in `Response.json` for
you. Dynamic segments work as they do for pages, arriving as
`(request, { params })`.

Two behaviours worth knowing, because they are not what a normal server
does:

- **A path that exists but not for that verb is a 405**, with an `Allow`
  header listing the methods the file exports. A handler is found by
  export name, so a typo gives you a 405 on a route you are sure you
  wrote.
- **An unclaimed path is not a 404.** Routing lives in the isolate, so
  every unmatched path serves the page shell and the socket decides. If you
  want a 404 for `/api/*`, write it.

Your own forms do not need any of this — a `<form>` submits over the socket
and a handler runs in the isolate with no round trip through HTTP.

## BPF

Put `*.bpf.c` in `bpf/` and `yeetkit dev` compiles it. Every unit is linked
into one loadable object, `bin/app.bpf.o`, with `bpftool gen object` — split
the program across as many files as you like and share structs and maps
through headers in `bpf/include/`. clang and bpftool come from the pinned
static toolchain `build/toolchain.mk` fetches once into a shared cache, so
there is no system C or BPF toolchain to install.

Then **import the object**:

```js
"use yeet";
import { RingBuf } from "yeet:bpf";
import program from "#/app.bpf.o";

const control = await program
  .bind("events", { kind: "ringbuf", btf_struct: "exec_event" })
  .attach("on_exec")     // a tracepoint carries its own hook in SEC()
  .start();

await new RingBuf(control, "events").subscribe((event) => { /* … */ });
```

The import is left external and the isolate's loader turns a `.bpf.o`
specifier into a `BpfObject`. That means the specifier is resolved relative
to the *bundle*, not to the file you wrote it in — so yeetkit rewrites it and
copies the object next to the bundle, and the same import works from
`.yeetkit/` in development and `dist/` in a build. A relative path to the
same object works too; `#/` just spares you knowing where it lands.
Importing one outside the isolate is a build error pointing you at
`"use yeet"`.

An edit to a `.bpf.c` recompiles and restarts the isolate, because the
program is loaded when the isolate starts rather than when a page asks for
it. `make veristat` loads the object and lets this kernel's verifier judge
it, which is the fastest way to read a rejection.

### Starting and stopping a probe

A BPF program should be attached while something is looking and detached
when nothing is. `createProbe` refcounts that:

```js
"use yeet";
import { createProbe } from "yeetkit";
import program from "#/app.bpf.o";

const probe = createProbe({
  linger: 5000,
  async start() {
    /* A *fresh* object per attach: the imported one is a module
       singleton whose binds accumulate, so a second start() fails
       with "Map 'events' already bound". */
    const control = await new BpfObject({ exe: program.exe })
      .bind("events", { kind: "ringbuf", btf_struct: "exec_event" })
      .attach("on_exec")
      .start();
    return { control };
  },
  stop: ({ control }) => control.stop(),
});

export const holdProbe = () => probe.hold("page");   // releases on unmount
export const probeState = () => probe.state;
```

A page calls `holdProbe()` in its body and the release is registered with
its own `onCleanup`, so navigating away is what lets go. It starts on the
first holder and stops on the last, after a grace period — so clicking
between pages does not reload and re-verify the program. `probe.state`
names its holders, because a refcount stuck at 1 tells you nothing about
which caller forgot to let go.

The settings live in the program's `.bss`, which the load creates: they last
exactly as long as the attachment, and a probe that stops forgets them.

### Cancelling a stream

A stream that waits must be handed the stop token and wait on it:

```js
export async function* tail(stop) {
  try {
    for (;;) {
      while (queue.length) yield queue.shift();
      await stop.until(nextEvent());
      if (stop.aborted) return;      // ← this is what runs the finally
    }
  } finally {
    release();
  }
}
```

**`iterator.return()` is not enough, and the failure is silent.** A reader
always has a `next()` in flight; a `return()` queues behind it; and a
generator that loops without reaching a `yield` never settles that `next()`.
On a quiet machine the return is never reached, the `finally` never runs,
and the producer stays alive holding whatever it holds — a BPF program
tracing the box for nobody.

The token is appended by whatever drives the stream, so a generator that
ignores it still works — it just is not cancellable, which is the thing this
makes visible rather than silent. In a page, `readStream(open, onValue)`
drives it and returns a stop function to hand to `onCleanup`.

### Writing maps from the UI

The read path is a ring buffer. The write path is the program's globals,
and it is what makes a page a control plane rather than a viewer:

```c
volatile __u8 paused;          /* patched from JavaScript */
volatile __u32 min_pid;
volatile __u8 want[COMM_LEN];
```

```js
"use yeet";
const bss = new DataSec(control, "app.bss");
await bss.patch({ paused: 0, min_pid: 7, want: bytes("echo") });
const live = await bss.read();     // read back from the kernel
```

`volatile` is not decoration — without it the compiler may fold in the zero
the global was initialised with and drop the load, so the map would accept
writes that changed nothing.

Then a `"use client"` island holds the form (typing must not take a round
trip) and calls that `"use yeet"` function on apply. The path from an input
to the kernel's decision is browser → hub → isolate → map, and the
filtering happens in the kernel *before* an event is written to the buffer —
so a narrow filter costs less than a wide one rather than more.

### Two things that will bite you

**A struct only reached through the `void *` that `bpf_ringbuf_reserve`
returns never makes it into the object's BTF**, and the reader needs it
there. The fix is an unused global:

```c
struct exec_event *_unused_exec_event __attribute__((unused));
```

Without it the map loads, the attach succeeds, and `subscribe` fails with
`No service for map "events"` — a long way from the cause.

**The data-section map is not called what the skeleton says.** libbpf names
it from the object name up to its first dot, truncated to 8 characters, so
`app.bpf.o` gives `app.bss`. `bpftool gen skeleton` prints `app_bpf.bss`,
because it is naming a C identifier rather than a map — follow that and you
get the same misleading "No service for map".

The template carries both, with comments saying why, and `yeetkit check`
asserts a value written to the map reads back *from the kernel* and that the
program honours it.

## Commands

| | |
|---|---|
| `yeetkit dev` | bundle, watch, supervise the isolate |
| `yeetkit build` | `dist/` — `server.js`, `index.html`, `client.js`, `styles.css` |
| `yeetkit start` | serve a build |
| `yeetkit check` | four phases: the wire, the dev server, islands in a DOM, and the hub |
| `make bpf` | compile `bpf/*.bpf.c` on its own |
| `make veristat` | load the object and let this kernel's verifier judge it |
| `yeetkit new <name>` | a project to start from |

`yeetkit dev` lists every reachable surface on start, and again whenever the
route set changes:

```
yeetkit  | http://localhost:3000
         GET  /                             page
         GET  /procs/:pid                   page
         WS   /@yeetkit/ws                  hub → isolate
         GET  /@yeetkit/styles.css          tailwind
         SSE  /@yeetkit/reload              dev only
         CALL app/lib/server.js#snapshot    node
         CALL app/lib/exec.js#configure     isolate
```

Every page is a `GET` because routing lives in the isolate: a path returns
the same shell and the socket decides what to render, so there is no
per-method page route and a form submits over the socket rather than
POSTing. The other verbs are real — the hub is a WebSocket upgrade, reload
is server-sent events. `CALL` is not HTTP at all; it is there because a
directive-exported function is reachable, and its runtime is the thing you
want to see next to its name.

An edit to a component rebuilds and restarts the isolate; the page's socket
drops and the client reconnects and asks for a fresh tree, so a save costs
one reconnect and no reload. An edit to `index.html`, `client.js` or the
stylesheet reloads the page instead. Adding a directory with a `page.jsx`
adds a route with no restart of anything you have to think about.

## What this is not

**One isolate is one running application, shared by everyone connected.**
(`"use client"` is the exception, and the reason it exists: island state is
per-browser.)
The portal is a tty and a tty is a broadcast: two tabs are two views of the
same state, not two sessions. For an instrument — a dashboard, an internal
tool, something watching a host — that is the useful behaviour and the
reason there is no per-request rendering anywhere in here. It is the wrong
shape for a public multi-user site, and no amount of configuration changes
that; it is what the transport is.

Consequences worth knowing before you build on it:

- **No SSR and no HTML for a crawler.** The first paint arrives over the
  socket. Fine behind auth, wrong for a marketing page.
- **A restart drops state.** Development restarts the isolate on every
  save. Reconnect is sub-second and the tree comes back, but signal state
  does not; real HMR would need module swap inside the isolate.
- **Latency is in the interaction loop.** Every click is a round trip. On
  a LAN or localhost this is invisible; over a bad link it is not. Solid's
  reactivity still runs on the host, so pure-client interactions (hover
  styling, CSS transitions) cost nothing — but anything in a handler does.
- **`yeet:*` is the standard library.** No `fetch`, no npm package that
  reaches for Node or the DOM. Everything else bundles in fine.

## Layout

```
src/runtime/     isolate side — bundled into your app
  renderer.js    Solid's universal renderer, targeting the wire
  mount.js       portal wiring, patch batching, the hello handshake
  router.js      matching, nested layouts, Link
  protocol.js    OSC framing (from yeet:notebook, unchanged)
src/client/      browser side — the 11kb mirror
src/cli/         dev server, bundler, route generation, Tailwind, check
```

`yeetkit check` is the test suite, in two phases. The first spawns a real
isolate, connects a real socket, and asserts on the patches — that a click
sends one text patch and not a re-render, that a shared layout survives a
navigation. The second starts the dev server and fetches every asset with a
timeout, because the ugliest failure mode on that side is not an error: a
route that returns without writing a response leaves the browser waiting,
and a render-blocking stylesheet that never arrives is a page that never
paints.
