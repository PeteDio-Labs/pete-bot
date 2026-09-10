/**
 * Hold the typing indicator open for as long as the work takes.
 *
 * ⚠ ONE sendTyping() IS NOT ENOUGH. Discord's indicator expires after about ten
 * seconds; MTRACE_TIMEOUT_MS is 60000 and a deep trace uses a good part of it. Between
 * those two numbers the DM shows nothing at all, which reads exactly like a bot that
 * ignored you — the thing the original single call was added to prevent.
 */

/** Comfortably inside Discord's ~10s expiry, so the indicator never lapses. */
export const TYPING_INTERVAL_MS = 8_000;

interface Typeable {
  sendTyping: () => Promise<unknown>;
}

export async function withTyping<T>(channel: Typeable, work: () => Promise<T>): Promise<T> {
  // Failing to show typing must never fail the answer, so every ping swallows its own
  // rejection rather than becoming an unhandled one.
  const ping = () => void channel.sendTyping().catch(() => {});

  ping();
  const timer = setInterval(ping, TYPING_INTERVAL_MS);

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
