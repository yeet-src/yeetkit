"use yeet";

/* Runs in the isolate — where the kernel is.
 *
 * `yeet.graph`, `yeet:bpf` and `yeet:ai` exist here and nowhere else,
 * so anything touching them belongs in a module marked like this. A
 * page calls it as an ordinary function, in the same process, at no
 * cost; an island or the host reaches it over the socket.
 */
export async function processCount() {
  const result = await yeet.graph.query(`{ procs { pid } }`);
  return result?.data?.procs?.length ?? 0;
}

/* What the status bar shows. One query rather than three, because the
 * bar updates on a timer and each of these is a walk of /proc.
 */
export async function hostStats() {
  const result = await yeet.graph.query(`{
    load_average { one }
    meminfo { mem_total mem_available }
    cpu { num_cores }
    procs { pid }
  }`);

  const data = result?.data ?? {};
  const total = data.meminfo?.mem_total ?? 0;
  const free = data.meminfo?.mem_available ?? 0;

  return {
    load: data.load_average?.one ?? 0,
    /* The denominator for load. A load of 3 means nothing until you
     * know whether the machine has two cores or thirty-two. */
    cores: data.cpu?.num_cores ?? 1,
    procs: data.procs?.length ?? 0,
    /* A fraction, so the caller decides how to show it. */
    mem: total > 0 ? (total - free) / total : 0,
  };
}
