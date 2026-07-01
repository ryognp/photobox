import "server-only";

type PerfFields = Record<string, string | number | boolean | null | undefined>;

function nowMs() {
  return performance.now();
}

export function createPerfLog(scope: string) {
  const start = nowMs();
  let last = start;
  const marks: Record<string, number> = {};

  function mark(name: string) {
    const current = nowMs();
    marks[name] = Math.round(current - last);
    last = current;
  }

  function end(fields: PerfFields = {}) {
    const totalMs = Math.round(nowMs() - start);
    console.info(`[perf:${scope}]`, {
      totalMs,
      ...marks,
      ...fields,
    });
  }

  return { mark, end };
}
