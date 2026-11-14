/**
 * What the guard entry's thread (guard-thread.ts) and the guard thread (guard-worker.ts) say to each other (T2433).
 * Both sides import this module, so it imports nothing: a module that fails to load under the entry would end it with
 * exit 1, which lets the tool call through. That is why it narrows records itself instead of using core/guards.ts.
 */

/** What the guard thread tells the entry, in this order: loaded or load-failed, then lines, then answered or crashed. */
export type GuardThreadMessage =
  | { readonly kind: 'loaded' }
  | { readonly kind: 'load-failed'; readonly message: string }
  | { readonly kind: 'stdout'; readonly line: string }
  | { readonly kind: 'stderr'; readonly line: string }
  | { readonly kind: 'answered'; readonly code: number }
  | { readonly kind: 'crashed'; readonly message: string };

/** The one run the entry asks of the guard thread: the CLI's arguments, its entry script and the hook's input. */
export interface GuardThreadRun {
  readonly argv: readonly string[];
  readonly script: string;
  readonly input: string;
}

function isFields(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGuardThreadMessage(value: unknown): value is GuardThreadMessage {
  if (!isFields(value)) {
    return false;
  }
  switch (value['kind']) {
    case 'loaded':
      return true;
    case 'load-failed':
    case 'crashed':
      return typeof value['message'] === 'string';
    case 'stdout':
    case 'stderr':
      return typeof value['line'] === 'string';
    case 'answered':
      return typeof value['code'] === 'number';
    default:
      return false;
  }
}

export function isGuardThreadRun(value: unknown): value is GuardThreadRun {
  if (!isFields(value)) {
    return false;
  }
  const argv = value['argv'];
  return Array.isArray(argv) && argv.every((arg) => typeof arg === 'string') && typeof value['script'] === 'string' && typeof value['input'] === 'string';
}

/** What a thrown value says, to carry across the thread as text. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
