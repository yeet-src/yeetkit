export default {
  title: "yeetkit app",
  port: 3000,
  /* The port the isolate's tty portal listens on. Loopback only: the
   * hub in the dev server is its one peer. */
  ws: 3001,
  /* Direct mode: the view leaves the isolate on its console lane, on a
   * second WebSocket the browser dials itself — Node is out of the
   * render path. Events and `"use server"` calls still go via the hub,
   * so nothing is lost but a hop; what is gained is that patches never
   * pass through Node. The console port defaults to `ws + 1`. */
  // direct: true,
  // console: 3002,
};
