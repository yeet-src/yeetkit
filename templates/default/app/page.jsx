import { createSignal } from "yeetkit";

import Filter from "@/lib/Filter.jsx";

export default function Home() {
  const [count, setCount] = createSignal(0);

  return (
    <section class="space-y-6">
      <h1 class="comment">it runs in the isolate</h1>

      <p class="max-w-prose text-dim">
        This component never reached the browser. It is executing on the host, inside a yeet
        isolate; the button below sends one event up the socket and the number that comes back is
        the only thing that changed.
      </p>

      {/* A plain text button. Emacs would draw this as [clicked 0
          times] and so does this. */}
      <button
        class="text-blue hover:underline hover:underline-offset-4"
        onClick={() => setCount(count() + 1)}
      >
        [clicked {count()} times]
      </button>

      {/* A `"use client"` island. Its show/hide is instant and local;
          the paragraph inside it is still server-rendered and still
          patched from the isolate — the count updates while the island
          owns the nodes around it. */}
      <Filter label="details">
        <p class="max-w-prose text-dim">
          Server-rendered, inside a client island. The counter above has been clicked{" "}
          <span class="text-fg">{count()}</span> times, and this text is patched from the isolate.
        </p>
      </Filter>
    </section>
  );
}
