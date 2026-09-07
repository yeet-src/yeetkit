/* Wire format for both directions of the `tty:ws://` portal.
 *
 * Taken from yeet:notebook's framework, unchanged: the escaping rules
 * here are load-bearing and already proven against a real portal.
 *
 * Down (isolate -> browser) the channel is PTY bytes, so a frame has
 * to survive terminal output processing: patches ride in an OSC
 * sequence, and the JSON is escaped to pure ASCII so no byte in it
 * can be rewritten on the way out (ONLCR turning \n into \r\n is the
 * one that would corrupt a payload).
 *
 * Up (browser -> isolate) the bytes are parsed by the terminal input
 * decoder before a script ever sees them, and it only surfaces key
 * and mouse events — an OSC sequence sent upward is swallowed. So an
 * event goes up as base64url, whose alphabet is entirely printable
 * ASCII and therefore arrives intact as one `keydown` per character,
 * terminated by Enter.
 */

export const OSC_OPEN = "\x1b]7880;";
export const OSC_CLOSE = "\x07";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeFrame(patch) {
  return `${OSC_OPEN}${ascii(JSON.stringify(patch))}${OSC_CLOSE}`;
}

/* JSON.stringify leaves printable non-ASCII as raw UTF-8 and control
 * characters are already escaped, so only the >0x7e range needs
 * lifting into \uXXXX.
 */
function ascii(json) {
  let out = "";
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    out += code > 0x7e ? `\\u${code.toString(16).padStart(4, "0")}` : json[i];
  }
  return out;
}

export function decodeBase64Url(text) {
  const bytes = [];
  let bits = 0;
  let width = 0;

  for (const character of text) {
    const value = B64.indexOf(character);
    if (value < 0) {
      continue; // padding and stray whitespace
    }
    bits = (bits << 6) | value;
    width += 6;
    if (width >= 8) {
      width -= 8;
      bytes.push((bits >> width) & 0xff);
    }
  }
  return utf8(bytes);
}

/* The browser encodes as UTF-8, so the bytes have to be decoded as
 * UTF-8. Reading each one as a code unit — which is what
 * String.fromCharCode over raw bytes does — turns every accented
 * letter, dash and emoji into mojibake. This isolate has no
 * TextDecoder, so it is done by hand.
 */
function utf8(bytes) {
  let out = "";

  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i++];
    let code;

    if (first < 0x80) {
      code = first;
    } else if (first < 0xe0) {
      code = ((first & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else if (first < 0xf0) {
      code = ((first & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    } else {
      code =
        ((first & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
    }
    out += String.fromCodePoint(code);
  }
  return out;
}

/* Reassembles one uplink message from the per-character keydown
 * events the terminal decoder produces. Returns the decoded object
 * on Enter, null while a message is still arriving.
 */
export function uplinkReader(onMessage) {
  let pending = "";

  return (event) => {
    if (event.code === "Enter") {
      const text = pending;
      pending = "";
      if (text.length === 0) {
        return;
      }
      try {
        onMessage(JSON.parse(decodeBase64Url(text)));
      } catch {
        // A partial or corrupt message is dropped, not fatal.
      }
      return;
    }

    const key = event.key ?? "";
    if (key.length === 1 && B64.includes(key)) {
      pending += key;
    }
  };
}
