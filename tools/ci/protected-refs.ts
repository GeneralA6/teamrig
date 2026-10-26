/**
 * The branches a push from a clone never updates: main changes only through a pull request, which GitHub merges.
 * The pre-push hook refuses an update or a deletion of one before any check runs (local-gate.ts, provePush).
 */
export const PROTECTED_REFS: readonly string[] = ['refs/heads/main'];

/** Why a push that updates or deletes a protected branch is refused, or undefined when it touches none. */
export function protectedPushRefusal(remoteRefs: readonly string[]): string | undefined {
  const protectedRef = remoteRefs.find((ref) => PROTECTED_REFS.includes(ref));
  return protectedRef === undefined
    ? undefined
    : `${protectedRef} changes only through a pull request: push a branch of your own and open a pull request from it`;
}
