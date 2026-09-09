/**
 * The one-line footer under every answer.
 *
 * ⚠ SHOW BOTH HALVES. mtrace splits routing from running because they fail for
 * different reasons — a slow route means ollama-host is busy or asleep, a slow tool
 * means the media stack is. Summing them into one number hides which, which is the
 * question "why did that take so long" is actually asking.
 */
export function footer(routedBy?: string, timing?: { routeMs?: number; toolMs?: number; totalMs?: number }): string | undefined {
  const bits: string[] = [];
  if (routedBy) bits.push(`routed by ${routedBy}`);
  if (timing?.totalMs !== undefined) {
    const parts: string[] = [];
    if (timing.routeMs !== undefined) parts.push(`route ${timing.routeMs}ms`);
    if (timing.toolMs !== undefined) parts.push(`tool ${timing.toolMs}ms`);
    bits.push(parts.length ? `${fmt(timing.totalMs)} (${parts.join(', ')})` : fmt(timing.totalMs));
  }
  return bits.length ? bits.join(' · ') : undefined;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
