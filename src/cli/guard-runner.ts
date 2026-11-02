import type { NodeEntry, runWithNode } from './node-main.ts';

/**
 * The fail-closed runner around teamrig's guard hooks (T1818). Claude Code lets a tool call through when a PreToolUse
 * command hook exits with anything but 0 or 2, or outlives its timeout, so a guard that cannot load, throws, hangs or
 * prints something other than its answer stops guarding with no sign. The runner turns each of those into exit 2,
 * which blocks the call and shows the model a line naming the guard, what went wrong and the fix.
 *
 * It imports nothing at run time (the import above is a type), so the code that can break under it is the CLI it loads.
 * Not caught: a synchronous endless loop (it never yields to the time limit, and Claude Code's timeout lets the call
 * through), the process running out of memory, a broken runner or entry script, and a missing Node.js.
 */

/**
 * How long a guard may run before the runner blocks the call. Under hooks.json's 15 s for the guards, so the runner
 * answers before Claude Code's timeout, which would let the call through; the margin covers Node.js starting.
 */
export const GUARD_LIMIT_MS = 12_000;

/** The CLI run the runner loads and judges: `runWithNode` in `node-main.ts`. */
export type GuardMain = typeof runWithNode;

/** What a guard run ended with. */
export type GuardOutcome =
  | { readonly kind: 'answered'; readonly code: number; readonly stdout: readonly string[] }
  | { readonly kind: 'load-failed'; readonly cause: unknown }
  | { readonly kind: 'crashed'; readonly cause: unknown }
  | { readonly kind: 'timed-out'; readonly limitMs: number };

/** What the runner tells Claude Code. */
export interface GuardVerdict {
  /** 0 passes the guard's answer on; 2 blocks the tool call. */
  readonly exitCode: 0 | 2;
  /** The answer Claude Code reads on exit 0: nothing, or the guard's one JSON object. */
  readonly stdout: string;
  /** Why the call is blocked, which Claude Code shows the model on exit 2; empty when the answer passes on. */
  readonly stderr: string;
}

/** What the runner takes from the process; `guard-main.ts` gives it the real one. */
export interface GuardHost {
  /** Calls `listener` on an uncaught exception or an unhandled rejection. */
  onFatal(listener: (cause: unknown) => void): void;
  /** Calls `fire` after `ms`, holding the process open until then; `release` stops the holding, not the call. */
  startLimit(ms: number, fire: () => void): { readonly release: () => void };
  write(text: string): void;
  writeError(text: string): void;
  /** Ends the process now. */
  exit(code: number): void;
  /** The code the process ends with once its work drains. */
  setExitCode(code: number): void;
}

/** What a thrown value says, on one line. */
function causeText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split(/\r?\n/, 1)[0] ?? '';
}

/** Whether `text` is one JSON object, the only answer a guard prints besides nothing. */
function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const UPDATE_FIX = 'run `claude plugin update teamrig@teamrig` and restart the session; if that does not clear it, tell your lead.';
const SLOW_FIX = 'retry the call; if every call times out, the host is overloaded or the guard hangs: tell your lead.';
/** The most of a wrong answer the block line quotes. */
const QUOTE_CHARS = 200;

function blocked(hook: string, what: string, fix: string): GuardVerdict {
  return {
    exitCode: 2,
    stdout: '',
    stderr: `teamrig blocked this call: its ${hook} guard ${what}, and a guard that cannot answer must not let a call through. Fix: ${fix}\n`,
  };
}

/** The verdict on a guard run: its answer passed on, or the call blocked. */
export function judgeGuard(hook: string, outcome: GuardOutcome): GuardVerdict {
  switch (outcome.kind) {
    case 'load-failed':
      return blocked(hook, `could not load (${causeText(outcome.cause)})`, UPDATE_FIX);
    case 'crashed':
      return blocked(hook, `crashed (${causeText(outcome.cause)})`, UPDATE_FIX);
    case 'timed-out':
      return blocked(hook, `gave no answer within ${outcome.limitMs / 1000} s`, SLOW_FIX);
    case 'answered':
      break;
  }
  const text = outcome.stdout.join('\n');
  if (outcome.code === 2) {
    // The guard's own block: Claude Code shows stderr then, not stdout, so what it printed moves there.
    return { exitCode: 2, stdout: '', stderr: text.trim() === '' ? '' : `${text}\n` };
  }
  if (outcome.code !== 0) {
    return blocked(hook, `ended with exit ${outcome.code}`, UPDATE_FIX);
  }
  if (text.trim() === '') {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  if (!isJsonObject(text)) {
    return blocked(hook, `printed something other than its JSON answer (${JSON.stringify(text.slice(0, QUOTE_CHARS))})`, UPDATE_FIX);
  }
  return { exitCode: 0, stdout: `${text}\n`, stderr: '' };
}

/**
 * Runs the guard `hook <name>` that `argv` names: loads the CLI with `load`, runs it with its stdout kept back, and
 * tells Claude Code the verdict. The first outcome decides; once the answer is out, the process may finish its work
 * until the limit, then ends with the verdict's code, so Claude Code's timeout never drops a given answer.
 */
export async function runGuard(argv: readonly string[], script: string, load: () => Promise<GuardMain>, host: GuardHost, limitMs = GUARD_LIMIT_MS): Promise<void> {
  const hook = argv[1] ?? 'hook';
  let verdict: GuardVerdict | undefined;
  const settle = (outcome: GuardOutcome): GuardVerdict => {
    if (verdict !== undefined) {
      return verdict;
    }
    const judged = judgeGuard(hook, outcome);
    if (judged.stdout !== '') {
      host.write(judged.stdout);
    }
    if (judged.stderr !== '') {
      host.writeError(judged.stderr);
    }
    verdict = judged;
    return judged;
  };
  const end = (outcome: GuardOutcome): void => host.exit(settle(outcome).exitCode);
  host.onFatal((cause) => end({ kind: 'crashed', cause }));
  const limit = host.startLimit(limitMs, () => end({ kind: 'timed-out', limitMs }));

  let main: GuardMain;
  try {
    main = await load();
  } catch (cause) {
    end({ kind: 'load-failed', cause });
    return;
  }
  const stdout: string[] = [];
  const entry: NodeEntry = { out: { stdout: (line) => stdout.push(line), stderr: (line) => host.writeError(`${line}\n`) }, script };
  try {
    const code = await main(argv, entry);
    host.setExitCode(settle({ kind: 'answered', code, stdout }).exitCode);
    limit.release();
  } catch (cause) {
    end({ kind: 'crashed', cause });
  }
}
