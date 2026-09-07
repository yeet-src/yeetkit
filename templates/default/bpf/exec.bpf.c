/* Every exec on this machine, as it happens — filtered in the kernel by
 * settings the page writes.
 *
 * A tracepoint on sched_process_exec fires for each successful execve;
 * the handler copies the pid, the parent, and the command name into a
 * ring buffer that the JavaScript side drains. That is the read path,
 * and the interesting part is what it costs: nothing polls and nothing
 * is sampled. The kernel hands you the event on the syscall's own path.
 *
 * The write path is the globals below. They live in the object's data
 * section, which the loader exposes as a map, so userspace can patch
 * them while the program is attached — and the program reads them on
 * every event. That is how a control in the browser becomes a decision
 * in the kernel: the filtering happens *here*, before the event is ever
 * written to the buffer, so a narrow filter costs less than a wide one
 * rather than more.
 *
 * Split this across as many bpf/*.bpf.c files as you like. Each is a
 * unit, compiled on its own, and all of them are linked into one
 * loadable object (bin/app.bpf.o) with `bpftool gen object` — share
 * structs and maps through headers in bpf/include/ and the linker
 * merges the duplicates.
 */

#include "vmlinux.h"

#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "GPL";

#define COMM_LEN 16

/* Patched from JavaScript through `DataSec`, read here on every event.
 *
 * `volatile` is not decoration: without it the compiler is entitled to
 * see a global that this program never writes, fold in the zero it was
 * initialised with, and drop the load — so the map would accept writes
 * that changed nothing. Zero-initialised, so they land in `.bss` and
 * the defaults are "everything, running".
 */
volatile __u8 paused;               /* 1 = drop every event */
volatile __u32 min_pid;             /* ignore pids below this */
volatile __u8 want[COMM_LEN];       /* comm prefix; empty = any */

/* Mirrored on the JS side, field for field, by the RingBuf reader in
 * app/lib/exec.js. Keep the two in step. */
struct exec_event {
  __u32 pid;
  __u32 ppid;
  __u8 comm[COMM_LEN];
};

/* The ring buffer's payload type has to appear in the object's BTF for
 * the reader on the JS side to decode it — and a struct that is only
 * ever reached through the `void *` that `bpf_ringbuf_reserve` returns
 * is not referenced by anything the compiler emits. This unused global
 * is what forces it out. Without it the map loads fine and the
 * subscribe fails with "No service for map", which is a long way from
 * the cause.
 */
struct exec_event *_unused_exec_event __attribute__((unused));

/* 256KiB is a lot of execs. The reader drains continuously, so this
 * only has to absorb a burst — a `make -j` storm, a shell script in a
 * loop — rather than the whole history. */
struct {
  __uint(type, BPF_MAP_TYPE_RINGBUF);
  __uint(max_entries, 256 * 1024);
} events SEC(".maps");

/* An empty filter passes everything; otherwise `comm` has to start with
 * it. The loop is bounded by a constant so the verifier can walk it,
 * and it stops at the first NUL in either string.
 */
static __always_inline int wanted(const __u8 *comm) {
  if (!want[0]) {
    return 1;
  }

  for (int i = 0; i < COMM_LEN; i++) {
    __u8 expect = want[i];
    if (!expect) {
      return 1; /* the whole prefix matched */
    }
    if (comm[i] != expect) {
      return 0;
    }
  }
  return 1;
}

SEC("tracepoint/sched/sched_process_exec")
int on_exec(void *ctx) {
  if (paused) {
    return 0;
  }

  __u32 pid = bpf_get_current_pid_tgid() >> 32;
  if (pid < min_pid) {
    return 0;
  }

  __u8 comm[COMM_LEN];
  bpf_get_current_comm(&comm, sizeof(comm));
  if (!wanted(comm)) {
    return 0;
  }

  struct exec_event *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
  /* A full buffer means the reader fell behind. Dropping is the right
   * answer: blocking here would slow every exec on the box. */
  if (!event) {
    return 0;
  }

  struct task_struct *task = (struct task_struct *)bpf_get_current_task();

  event->pid = pid;
  event->ppid = BPF_CORE_READ(task, real_parent, tgid);
  __builtin_memcpy(event->comm, comm, COMM_LEN);

  bpf_ringbuf_submit(event, 0);
  return 0;
}
