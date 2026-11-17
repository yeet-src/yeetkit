/* Wire format for both directions of a named portal.
 *
 * A named portal carries whole messages each way, one peer at a time,
 * and a string arrives as the string that was sent. So a frame is just
 * JSON: one message, one object.
 *
 * This file used to be the hard part. The transport was the isolate's
 * tty, which is PTY bytes down and terminal input up — patches rode in
 * an OSC escape with the JSON lifted to pure ASCII, and events came up
 * as base64url, one `keydown` per character, terminated by Enter. None
 * of that survives the move: there is no terminal in the path to
 * rewrite a byte or swallow a sequence.
 */

/* The portal names the script opens, and `yeet run -p <name>:ws://...`
 * binds. `hub` is control and stays with Node; `view` is the tree, and
 * in direct mode is the one browsers dial themselves. */
export const HUB = "hub";
export const VIEW = "view";

export const encodeFrame = (message) => JSON.stringify(message);

/* Null for anything that is not a message — bytes, or text that does
 * not parse. A bad frame is dropped, not fatal. */
export function decodeFrame(data) {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
