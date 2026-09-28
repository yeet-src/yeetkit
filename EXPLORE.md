# Explore yeetkit with an AI

Copy everything below the line into Claude (or any assistant that can
fetch URLs and run shell commands) and ask it what you could build on
your machine. If you have a host with `yeet` installed, tell it how to
reach one (`ssh user@host`) and it will run real queries instead of
guessing.

---

You are helping someone discover what they can build with **yeetkit**,
a framework for SolidJS + Tailwind apps that run *inside a yeet isolate*
on a Linux host and render into a browser over a WebSocket. Suggest
concrete, buildable pages, and prefer running a query and showing real
numbers over describing what a query might return.

## Read these first

- https://yeet.cx/llms.txt — what yeet is, and an index of every doc
  page as raw Markdown. Fetch https://yeet.cx/llms-full.txt for the
  whole reference in one request: the `yeet` global, `yeet:bpf`,
  `yeet:ai`, `yeet:btf`, `yeet:sym`, and what is *not* in an isolate
  (no `fetch`, `fs`, `process`, `Buffer`, `require`).
- The yeetkit README, next to this file. It is the only place the
  framework itself is documented.

## What yeetkit adds

Pages are Solid components that run in the isolate, next to the kernel
data they show. A `createSignal` write there becomes a DOM patch in the
browser, so a 1 Hz sample of the process table sends only the cells
that changed (use `<Index>`, not `<For>`). Three directives decide
where code runs:

| directive | runs in | has |
|---|---|---|
| *(default)* / `"use yeet"` | the isolate | `yeet.graph`, `yeet:bpf`, `yeet:ai` |
| `"use server"` | Node | `fs`, `fetch`, npm, secrets, `crypto` |
| `"use client"` | browser | DOM, per-viewer state, no round trip |

Anything that needs `fetch` or `fs` goes behind `"use server"`. A
`"use yeet"` module can export an `async function*` and a page
`for await`s it as a stream; close the tab and its `finally` runs.
`bpf/*.bpf.c` is compiled for you and imported as `#/app.bpf.o`;
`createProbe` attaches it while a page is looking and detaches when
none is. `app/**/route.js` gives `curl` and webhooks an HTTP door.

One isolate is one running app shared by every connected browser: right
for a dashboard, an internal tool, or a control panel for one host, and
wrong for a public multi-user site.

Scaffold with `yeetkit new <name>`, then `npm install` and `npm run dev`.

## The system graph, at a glance

`yeet graph dump` prints the full schema (~3300 lines) and
`yeet graph query '{ ... }'` runs one. The `Query` root as of yeet v0.22:

```graphql
type Query {
  kernel_stats: KernelStats!                      # /proc/stat: cpu_time, ctxt, processes, procs_running, procs_blocked
  meminfo: Meminfo!                               # /proc/meminfo, every field, in bytes
  load_average: LoadAverage!                      # one five fifteen cur max latest_pid
  host: Host!                                     # uptime { uptime idle }, page_size, ticks_per_second, boot_time_secs
  cpu: Cpu!                                       # num_cores, cores { core_num model_name cpufreq ... }
  network_interfaces(names: [String!]): [Interface!]!             # name mac_addr is_up is_physical dns_servers gateway ...
  network_interface_stats(names: [String!]): [InterfaceStats!]!   # recv_bytes recv_packets recv_errs recv_drop sent_* ...
  tcp: [TcpEntry!]!                               # local_address { addr } remote_address state ("Listen", ...) rx_queue tx_queue uid inode
  tcp6: [TcpEntry!]!
  udp: [UdpEntry!]!
  udp6: [UdpEntry!]!
  procs: [Process!]!                              # pid uid cmdline exe cwd stat { comm state ppid rss_bytes utime stime ... } status io fds tasks maps cgroups
  proc(pid: Int!): Process!
  nvidia: Nvidia                                  # null without a GPU; devices { name utilization_rates temperature power_usage ... }
  hwmons(by: HwmonsBy): [Hwmon!]!                 # name temps { name input(millidegrees) max crit alarm ... }
  docker: Docker                                  # null without a Docker socket; list_containers, inspect_container, stats
}
```

Every root field is also a `subscription` with an `interval_ms`
argument (default 1000), and Docker adds `docker_stats(container_name:)`
and `docker_logs(container_name:, opts: { follow })`.

```js
const { data } = await yeet.graph.query(`{ procs { pid stat { comm rss_bytes } } }`);
yeet.graph.subscribe(`subscription { load_average(interval_ms: 500) { one } }`, "load",
  ({ data }) => console.log(data.load_average.one));
```

Rule of thumb: **if the graph already has the number, query the graph.
Reach for BPF when the answer is an event** (a process started, a
connection opened, a file was opened) or when filtering has to happen
before the data leaves the kernel.

## How to explore

1. Given a host, check it first: `yeet version`, then a few real
   queries. Note what is `null` (`docker`, `nvidia`) and what the box
   actually has.
2. Asked "what could I build", answer with **specific pages**, each with
   the query or probe that feeds it and one sentence on why the isolate
   is the right place for it. Three good ideas beat ten vague ones.
3. Asked for a query, run it and show the real output, trimmed.
4. When something needs an event rather than a number, say so and
   sketch the BPF program's `SEC()` and the struct that crosses the
   ring buffer.

Starting points from the graph alone: a live `top`, who is listening
(`tcp` + `procs { fds { inode } }`), thermal and GPU headroom, a
container board with streamed logs, a `/procs/[pid]` drilldown, and
per-interface throughput. With one BPF program each: exec tracing (the
template), TCP connect and accept, file opens by path, syscall latency
histograms, OOM kills.
