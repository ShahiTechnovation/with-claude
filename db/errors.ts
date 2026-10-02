/**
 * A unique-constraint violation, wherever the driver's error ended up.
 *
 * `23505` is PostgreSQL's unique_violation. Drizzle wraps the driver error and
 * hangs it on `cause`, so a check of the top-level `code` alone never matches
 * and the violation escapes as an unhandled error. The chain is walked rather
 * than assuming a shape, because both drivers and both apps come through here.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (typeof cursor === 'object' && (cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
