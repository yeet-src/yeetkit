/* The page the browser loads.
 *
 * It is deliberately almost empty: a stylesheet, a mount point, and
 * the client. Everything else arrives over the socket, so there is no
 * server-rendered markup to hydrate and no flash of the wrong route —
 * the first frame the isolate sends is already the right page.
 */

/* A `public/favicon.*` is the site's icon; without one the browser
 * asks for /favicon.ico and gets the page shell, which is a wasted
 * socket. Checked at start (and after a public/ change in dev). */
export async function findIcon(publicDir) {
  const { access } = await import("node:fs/promises");
  for (const name of ["favicon.svg", "favicon.ico", "favicon.png"]) {
    try {
      await access(`${publicDir}/${name}`);
      return `/${name}`;
    } catch {
      /* next */
    }
  }
  return null;
}

export function indexHtml({ title, dev, direct = null, icon = null }) {
  /* Direct mode: the view comes straight from the isolate's console
   * portal, on the page's own host at the configured port. The hub
   * socket stays, for events and private replies. */
  const view = direct ? `, { view: \`\${scheme}://\${location.hostname}:${direct}/\` }` : "";
  /* Dev serves the framework's files from a namespaced path; a build
   * copies them next to the page. */
  const client = dev ? "/@yeetkit/client.js" : "./client.js";
  const css = dev ? "/@yeetkit/styles.css" : "./styles.css";
  const islands = dev ? "/@yeetkit/islands.js" : "./islands.js";
  const reload = dev
    ? `
    <script>
      /* The dev server reloads the page when the page itself changes;
         an edit to the app restarts the isolate instead, and the
         client reconnects without a reload. */
      new EventSource("/@yeetkit/reload").onmessage = () => location.reload();
    </script>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${css}" />${icon ? `\n    <link rel="icon" href="${icon}" />` : ""}
    <style>
      /* The only styling that cannot wait for the socket: what the
         page looks like before, and between, connections. */
      body[data-state="reconnecting"] { opacity: 0.6; transition: opacity 150ms 400ms; }
    </style>
  </head>
  <body data-state="connecting">
    <div id="app"></div>
    <script type="module">
      /* The island bundle is imported by the client under a fixed path,
         so a build has to answer there too. */
      window.__yeetkitIslands = "${islands}";
      import { connect } from "${client}";
      /* The hub lives on this page's own origin. The isolate's tty
         portal is loopback-only and Node is the one peer on it; in
         direct mode a second socket dials the isolate's console lane
         for the view. */
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      connect(\`\${scheme}://\${location.host}/@yeetkit/ws\`, document.getElementById("app")${view});
    </script>${reload}
  </body>
</html>
`;
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
