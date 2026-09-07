/* The build: JSX -> Solid's universal output -> one module the
 * isolate can run.
 *
 * Two things make this different from an ordinary web build.
 *
 * The isolate is not a browser and not Node. It has no `fetch`, no
 * `TextEncoder`, no `URL`, no `Buffer` — it has plain JavaScript and
 * the `yeet:*` builtins. So the bundle is `platform: "neutral"`,
 * everything the app uses is bundled in, and `yeet:*` is the only
 * thing left external.
 *
 * And the JSX is compiled for a renderer that is not the DOM.
 * `babel-preset-solid` in `generate: "universal"` mode lowers `<div
 * class="p-4">` into calls on our renderer, which is why lowercase
 * tags and Tailwind class strings work here even though the isolate's
 * own JSX runtime would reject them: by the time the isolate sees
 * this file, there is no JSX left in it.
 */

import * as babel from "@babel/core";
import solidPreset from "babel-preset-solid";
import typescriptPreset from "@babel/preset-typescript";
import { context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { readFile } from "node:fs/promises";

import { bpfImports } from "./bpf.mjs";
import { directiveOf, exportKindsOf, exportsOf, findModules } from "./directives.mjs";
import { collectApiRoutes } from "./routes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const RUNTIME = join(here, "..", "runtime");
const RENDERER = join(RUNTIME, "renderer.js");
const CLIENT_ISLANDS = join(here, "..", "client", "islands.js");

/* An application is not required to depend on Solid, Babel or
 * esbuild — it depends on yeetkit, and yeetkit brings them. So both
 * resolvers are pointed here: Babel gets preset objects rather than
 * names (it would otherwise look beside the file it is compiling),
 * and esbuild gets this package's `node_modules` as a fallback root.
 */
const OWN_MODULES = join(here, "..", "..", "node_modules");

/* Every `.jsx`/`.tsx` goes through Babel first — including the
 * framework's own, so a component shipped here is compiled by exactly
 * the pipeline an application's components are.
 */
/* JSX for whichever side is being built. `universal` lowers to our wire
 * renderer; `dom` lowers to Solid's real DOM one, which is what an
 * island needs. The same file can be compiled both ways — a helper
 * shared between a page and an island is bundled once per side. */
async function compileSolid(path, source, generate) {
  const out = await babel.transformAsync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    sourceMaps: "inline",
    presets: [
      path.endsWith(".tsx") ? [typescriptPreset, { isTSX: true, allExtensions: true }] : null,
      generate === "dom" ? [solidPreset, {}] : [solidPreset, { generate: "universal", moduleName: RENDERER }],
    ].filter(Boolean),
  });
  return out.code;
}

const solidJsx = (generate) => ({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/, namespace: "file" }, async (args) => ({
      contents: await compileSolid(args.path, await readFile(args.path, "utf8"), generate),
      loader: "js",
    }));
  },
});

/* Two aliases, matching the ones a `yeet new` project uses:
 *
 *   @/  the app root, so a deep component imports a helper by where it
 *       lives rather than by how far away it is
 *   #/  the linked BPF objects, so the one import whose path is a
 *       build artifact does not have to know the build's layout
 *
 * `#/` is handled by the BPF plugin instead of here, because what it
 * resolves to is not a file on the source path — it is a specifier the
 * isolate resolves at runtime, next to the bundle.
 */
const aliases = ({ appDir }) => ({
  name: "aliases",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: join(appDir, args.path.slice(2)),
    }));
  },
});

/* `yeetkit` resolves to the runtime without the app needing the
 * package installed as a dependency — the framework is already here.
 */
const selfImport = {
  name: "yeetkit-self",
  setup(build) {
    build.onResolve({ filter: /^yeetkit$/ }, () => ({ path: join(RUNTIME, "index.js") }));
    build.onResolve({ filter: /^yeetkit\/renderer$/ }, () => ({ path: RENDERER }));
  },
};

/* The directive plugin. One module can mean three different things
 * depending on which bundle is being built, and this is where that is
 * decided.
 *
 *   side "server"   a "use client" module is replaced by markers, one
 *                   per export; a "use server" module is wrapped so its
 *                   exports register as callable actions.
 *   side "client"   a "use client" module is compiled for the DOM; a
 *                   "use server" module is replaced by stubs that send
 *                   a message; a "use yeet" module — or anything
 *                   reaching for a `yeet:*` builtin — is an error,
 *                   because it cannot run there and shipping it would
 *                   be the bug.
 *
 * `islands` and `actions` are filled in as a side effect, which is how
 * the generated client entry knows what to register.
 */
function directives({ side, root, islands, actions, isolateFns }) {
  const idOf = (file) => relative(root, file).replaceAll("\\", "/");

  const stubs = (names, body) =>
    names
      .map((name) =>
        name === "default" ? `export default ${body(name)};` : `export const ${name} = ${body(name)};`,
      )
      .join("\n");

  return {
    name: "directives",
    setup(build) {
      if (side === "client") {
        build.onResolve({ filter: /^yeet:/ }, (args) => ({
          errors: [
            {
              text: `"${args.path}" is a host builtin and cannot run in the browser`,
              notes: [
                {
                  text:
                    `It was reached from ${idOf(args.importer)}. Put the work in a ` +
                    `"use yeet" function and call that from the island instead.`,
                },
              ],
            },
          ],
        }));
      }

      /* Explicitly the file namespace. Without it esbuild runs this for
       * every namespace — including the `impl` one below, which would
       * wrap the wrapper it just produced. */
      build.onLoad({ filter: /\.[jt]sx?$/, namespace: "file" }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const directive = directiveOf(source);
        if (!directive) return null; // the common case: an isolate module

        const id = idOf(args.path);
        const names = await exportsOf(source, args.path);
        const real = `${args.path}?impl`;

        // ---- "use client": the browser -------------------------------

        if (directive === "use client") {
          if (side === "client") return null; // compiled for the DOM below
          for (const name of names) islands.add(`${id}#${name}`);

          if (side === "server") {
            return {
              contents:
                `import { island } from ${JSON.stringify(join(RUNTIME, "island.js"))};\n` +
                stubs(names, (name) => `island(${JSON.stringify(`${id}#${name}`)})`),
              loader: "js",
            };
          }
          return {
            errors: [{ text: `${id} is "use client" and cannot run in the host process` }],
          };
        }

        // ---- "use server": the Node host -----------------------------

        if (directive === "use server") {
          for (const name of names) actions.add(`${id}#${name}`);

          /* The host keeps the real bodies. Everywhere else gets a stub,
           * which is what lets a `"use server"` function hold a secret:
           * it is the only one of the three that never travels. */
          if (side === "node") return null;

          const callFrom =
            side === "client"
              ? { module: CLIENT_ISLANDS, fn: "callNode" }
              : { module: join(RUNTIME, "node.js"), fn: "nodeCall" };

          return {
            contents:
              `import { ${callFrom.fn} } from ${JSON.stringify(callFrom.module)};\n` +
              stubs(
                names,
                (name) => `(...args) => ${callFrom.fn}(${JSON.stringify(`${id}#${name}`)}, args)`,
              ),
            loader: "js",
          };
        }

        // ---- "use yeet": the isolate ---------------------------------

        if (directive === "use yeet") {
          const kinds = new Map(await exportKindsOf(source, args.path));
          const isStream = (name) => kinds.get(name) === "stream";
          for (const name of names) isolateFns.add(`${id}#${name}${isStream(name) ? "*" : ""}`);

          /* The isolate keeps the real module and registers each export,
           * so a page calls it directly — no round trip for the case
           * that does not need one. */
          if (side === "server") {
            /* A generator registers as a stream and a function as a
             * call, but both are re-exported as themselves — a page in
             * the same process calls either one directly. */
            return {
              contents:
                `import { registerAction, registerStream } from ${JSON.stringify(join(RUNTIME, "rpc.js"))};\n` +
                `import * as impl from ${JSON.stringify(real)};\n` +
                stubs(names, (name) =>
                  isStream(name)
                    ? `registerStream(${JSON.stringify(`${id}#${name}`)}, impl.${name})`
                    : `registerAction(${JSON.stringify(`${id}#${name}`)}, impl.${name})`,
                ),
              loader: "js",
            };
          }

          if (side === "client") {
            return {
              contents:
                `import { callServer, streamServer } from ${JSON.stringify(CLIENT_ISLANDS)};\n` +
                stubs(names, (name) =>
                  isStream(name)
                    ? `(...args) => streamServer(${JSON.stringify(`${id}#${name}`)}, args)`
                    : `(...args) => callServer(${JSON.stringify(`${id}#${name}`)}, args)`,
                ),
              loader: "js",
            };
          }

          /* From the host: out over the socket the hub already holds.
           * Streams are not offered here — the host has no reader to
           * hand them to, and a `"use server"` function that wants a
           * stream of kernel events should be an isolate function. */
          return {
            contents: stubs(names, (name) =>
              isStream(name)
                ? `() => { throw new Error(${JSON.stringify(`"${id}#${name}" is a stream and cannot be consumed from "use server"`)}); }`
                : `(...args) => globalThis.__yeetkitCallIsolate(${JSON.stringify(`${id}#${name}`)}, args)`,
            ),
            loader: "js",
          };
        }

        return null;
      });

      /* The `?impl` suffix above would not resolve on its own; this
       * hands back the real file with the directive already spent, so
       * the wrapper can import what it wraps. */
      build.onResolve({ filter: /\?impl$/ }, (args) => ({
        path: args.path.replace(/\?impl$/, ""),
        namespace: "impl",
      }));
      build.onLoad({ filter: /.*/, namespace: "impl" }, async (args) => {
        const source = await readFile(args.path, "utf8");
        /* Compiled here rather than left to esbuild's own JSX loader,
         * which would lower to React calls. */
        return {
          contents: /\.[jt]sx$/.test(args.path)
            ? await compileSolid(args.path, source, side === "client" ? "dom" : "universal")
            : source,
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

export async function createBundler({ entry, outfile, dev, onRebuild, root, appDir, side = "server", islands, actions, isolateFns }) {
  const reporter = {
    name: "report",
    setup(build) {
      build.onEnd((result) => onRebuild?.(result));
    },
  };

  const client = side === "client";
  const node = side === "node";

  return context({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    /* The browser bundle is a browser bundle; the isolate is neither a
     * browser nor Node, so it gets `neutral` and everything inlined. */
    platform: client ? "browser" : node ? "node" : "neutral",
    target: client ? "es2020" : node ? "node20" : "es2022",
    /* The isolate's console is the only place a stack trace lands, so
     * development keeps names and skips minification. */
    minify: !dev && !node,
    sourcemap: dev ? "inline" : false,
    keepNames: dev,
    /* `yeet:ai`, `yeet:bpf`, `yeet:graph` and friends are provided by
     * the host and must survive bundling untouched. In the client
     * bundle they are not external, they are an error — see the
     * directive plugin. */
    external: client ? [] : ["yeet:*"],
    /* The host bundle leaves npm alone: a `"use server"` function is
     * allowed to reach for a database driver or anything else with a
     * native binding, and those must be required at runtime from the
     * project's own node_modules rather than inlined. */
    packages: node ? "external" : undefined,
    /* Solid ships a dedicated build for custom renderers; without this
     * condition the DOM one is resolved and the isolate side breaks.
     * The island bundle wants exactly the opposite. */
    conditions: client ? ["browser"] : node ? ["node"] : ["solid"],
    nodePaths: [OWN_MODULES],
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    logLevel: "silent",
    plugins: [
      selfImport,
      aliases({ appDir: appDir ?? join(root, "app") }),
      bpfImports({ side }),
      directives({ side, root, islands, actions, isolateFns }),
      solidJsx(client ? "dom" : "universal"),
      reporter,
    ],
  });
}

/* The generated island entry: everything the server pass found, wired
 * to its id. An app with no `"use client"` module still gets one of
 * these — an empty module is cheaper to serve than a special case in
 * the client, and it keeps the "always answer" rule intact.
 */
export function islandsModule(islands, { root, out }) {
  if (islands.size === 0) return "export const empty = true;\n";

  const lines = [
    `import { registerIsland } from ${JSON.stringify(CLIENT_ISLANDS)};`,
    `export { callServer, feed, mount, settle, setTransport, unmount } from ${JSON.stringify(CLIENT_ISLANDS)};`,
  ];

  let n = 0;
  for (const id of islands) {
    const [file, name] = id.split("#");
    const local = `_i${n++}`;
    /* The ids are relative to the project for legibility; the import
     * has to be relative to where this module is written. */
    const from = `./${relative(out, join(root, file)).replaceAll("\\", "/")}`;
    lines.push(
      name === "default"
        ? `import ${local} from ${JSON.stringify(from)};`
        : `import { ${name} as ${local} } from ${JSON.stringify(from)};`,
    );
    lines.push(`registerIsland(${JSON.stringify(id)}, ${local});`);
  }
  return lines.join("\n") + "\n";
}

/* The generated entry. It exists so an application never has to write
 * the wiring: point `serve()` at the router, hand it the routes the
 * `app/` tree produced, and park.
 */
export async function entryModule({ title, appDir, out, direct = false }) {
  /* Every `"use yeet"` module is imported for its side effect —
   * registering its exports — whether or not anything on this side
   * references it. Its callers are often an island or the host, and
   * neither shows up in this graph. */
  const actionModules = await findModules(appDir, "use yeet");
  const imports = actionModules
    .map((file) => `import ${JSON.stringify(`./${relative(out, file).replaceAll("\\", "/")}`)};`)
    .join("\n");

  return `import { serve, Router } from "yeetkit";
import { routes, notFound } from "./routes.js";
import { createComponent } from "yeetkit/renderer";
${imports}

await serve(() => createComponent(Router, { routes, fallback: notFound }), {
  title: ${JSON.stringify(title)},
  direct: ${direct ? "true" : "false"},
});
`;
}

/* The host bundle's entry: every `"use server"` module, keyed by the
 * same id the isolate and the browser will call it by.
 *
 * Generated from a scan rather than from what happens to be imported —
 * a `"use server"` function's only callers are a page or an island,
 * and on this side neither exists. The id has to be computed exactly
 * as the directive plugin computes it, or a call arrives for a name
 * the registry does not have.
 */
export async function nodeModule({ appDir, root, out }) {
  const files = await findModules(appDir, "use server");
  const api = await collectApiRoutes(appDir);

  const lines = [];
  const parts = [];

  files.forEach((file, n) => {
    const local = `_n${n}`;
    const from = `./${relative(out, file).replaceAll("\\", "/")}`;
    const id = relative(root, file).replaceAll("\\", "/");
    lines.push(`import * as ${local} from ${JSON.stringify(from)};`);
    parts.push(
      `  ...Object.fromEntries(Object.entries(${local}).map(([name, fn]) => [${JSON.stringify(id)} + "#" + name, fn])),`,
    );
  });

  /* Route modules are namespace-imported and their methods picked out
   * by name, so a handler added to an existing file needs no
   * regeneration beyond this module being rewritten. */
  const routes = [];
  api.forEach((route, n) => {
    const local = `_a${n}`;
    const from = `./${relative(out, route.file).replaceAll("\\", "/")}`;
    lines.push(`import * as ${local} from ${JSON.stringify(from)};`);
    routes.push(
      `  { segments: ${JSON.stringify(route.segments)}, methods: ${JSON.stringify(route.methods)}, ` +
        `file: ${JSON.stringify(relative(root, route.file).replaceAll("\\", "/"))}, handlers: ${local} },`,
    );
  });

  lines.push("");
  lines.push("export const actions = {");
  lines.push(...parts);
  lines.push("};");
  lines.push("");
  lines.push("export const routes = [");
  lines.push(...routes);
  lines.push("];");
  return lines.join("\n") + "\n";
}
