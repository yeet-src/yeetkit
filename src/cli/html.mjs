/* The page the browser loads.
 *
 * It is deliberately almost empty: a stylesheet, a mount point, and
 * the client. Everything else arrives over the socket, so there is no
 * server-rendered markup to hydrate and no flash of the wrong route —
 * the first frame the isolate sends is already the right page.
 */

export function indexHtml({ title, wsPort, dev }) {
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
    <link rel="stylesheet" href="${css}" />
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
      /* The hub lives on this page's own origin — the isolate's portal
         is loopback-only and Node is the one peer on it. */
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      connect(\`\${scheme}://\${location.host}/@yeetkit/ws\`, document.getElementById("app"));
    </script>${reload}
  </body>
</html>
`;
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
