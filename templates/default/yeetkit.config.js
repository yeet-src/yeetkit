export default {
  title: "yeetkit app",
  /* The HTTP port. `PORT` in the environment overrides this, and
   * `--port` on the command line overrides both. */
  port: 3000,
  /* The port the isolate's portals listen on: `hub` for control and
   * `view` for the tree, told apart by path. Loopback only: the hub in
   * the dev server is their one peer. */
  ws: 3001,
  /* Direct mode: the `view` portal is bound to a port of its own that
   * the browser dials itself — Node is out of the render path. Events
   * and `"use server"` calls still go via the hub, so nothing is lost
   * but a hop; what is gained is that patches never pass through
   * Node. The view port defaults to `ws + 1`. */
  // direct: true,
  // view: 3002,
};
