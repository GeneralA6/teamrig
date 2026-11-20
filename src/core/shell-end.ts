/** How a shell command or a program ended: its exit code, or the signal that stopped it. */
export type ShellEnd = { readonly kind: 'exited'; readonly code: number } | { readonly kind: 'signal'; readonly signal: string };

/** The end Node reports on `close`: a code, or no code and the signal that stopped the process. */
export function endOf(code: number | null, signal: string | null): ShellEnd {
  return code === null ? { kind: 'signal', signal: signal ?? 'an unknown signal' } : { kind: 'exited', code };
}
