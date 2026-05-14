/**
 * Wrap a promise with a timeout. Rejects with a clear error if the promise
 * doesn't settle before `ms` elapses. Used to keep slow Shopify / external
 * calls from blocking the scheduling loop or a request handler indefinitely.
 *
 * Note: Node's `fetch` already supports `AbortSignal.timeout(...)` for
 * outbound HTTP — prefer that when you control the fetch call. This helper
 * is for cases where the underlying call doesn't expose an abort hook
 * (e.g. `unauthenticated.admin(shop)` inside the Shopify SDK).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
