import type { DeployCheckConfig } from '../config/types.ts';
import type { ClearancePhase, Readiness } from '../delivery/clearance.ts';
import type { Env } from '../core/home.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { HOOK_WAIT_EXIT, type HookEnd, type HookRunner } from './hooks.ts';

/** A check's exit codes: go and refuse, beside every hook's wait (`HOOK_WAIT_EXIT`); any other end makes the deploy wait, so a broken check never lets it through. */
export const CHECK_GO_EXIT = 0;
export const CHECK_REFUSE_EXIT = 2;

/** A stdout line that names what the deploy brings, such as an image tag; the last one wins. */
const TAG_LINE = /^tag=([A-Za-z0-9._:-]{1,128})$/;

/** A line a hook printed, once redacted, is cut to this many characters where others read it. */
export const HOOK_LINE_MAX_CHARS = 300;

/** What a check printed that the deploy reads: its first line that is not a tag (its reason), and its last tag. */
export class CheckOutput {
  private first: string | undefined;
  private last: string | undefined;

  /** Takes one stdout line; pass it as a hook's `onLine`. */
  readonly hear = (line: string): void => {
    const text = line.trim();
    const tag = TAG_LINE.exec(text)?.[1];
    if (tag !== undefined) {
      this.last = tag;
    } else if (this.first === undefined && text !== '') {
      this.first = text;
    }
  };

  get reason(): string | undefined {
    return this.first;
  }

  get tag(): string | undefined {
    return this.last;
  }
}

/** `line` with its secrets redacted, cut to `HOOK_LINE_MAX_CHARS`: fit for a wait, a refusal or the ledger. */
export function shownLine(scanner: Pick<SecretScanner, 'redact'>, line: string): string {
  const shown = scanner.redact(line);
  return shown.length <= HOOK_LINE_MAX_CHARS ? shown : `${shown.slice(0, HOOK_LINE_MAX_CHARS - 1)}…`;
}

/** What a check's end means for the deploy: its exit code read as go, wait or refuse; any other end waits. */
export function checkReadiness(name: string, end: HookEnd, reason: string | undefined, timeoutSeconds: number): Readiness {
  const because = reason === undefined ? '' : `: ${reason}`;
  switch (end.kind) {
    case 'exited':
      if (end.code === CHECK_GO_EXIT) {
        return { kind: 'go' };
      }
      if (end.code === CHECK_REFUSE_EXIT) {
        return { kind: 'refuse', reason: `check ${name} refuses the deploy${because}` };
      }
      if (end.code === HOOK_WAIT_EXIT) {
        return { kind: 'wait', reason: `check ${name} holds the deploy${because}` };
      }
      return { kind: 'wait', reason: `check ${name} failed (exit ${end.code}), so the deploy waits${because}` };
    case 'timedOut':
      return { kind: 'wait', reason: `check ${name} gave no answer within ${timeoutSeconds} s, so the deploy waits` };
    case 'signal':
      return { kind: 'wait', reason: `check ${name} was stopped by ${end.signal}, so the deploy waits` };
    case 'notStarted':
      return { kind: 'wait', reason: `check ${name} could not start (${end.error}), so the deploy waits` };
    case 'stopped':
      return { kind: 'wait', reason: `check ${name} was killed when its launching shell ended, so the deploy waits` };
  }
}

export interface CheckRun {
  readonly hooks: HookRunner;
  readonly scanner: Pick<SecretScanner, 'redact'>;
  readonly cwd: string;
  /** Every hook's environment: this process's, with the deploy's `TEAMRIG_*` variables. */
  readonly env: Env;
  readonly timeoutSeconds: number;
}

/** The checks' answer: the first that does not pass, else go with the last tag a check printed. */
export type ChecksAnswer = { readonly readiness: Readiness; readonly tag: string | undefined };

/**
 * Asks each check in order, with `TEAMRIG_CHECK_NAME` and `TEAMRIG_CHECK_PHASE` set, and stops at the first that does
 * not pass. Each reason is redacted, since a wait or refusal is printed and may reach the ledger.
 */
export async function askChecks(checks: readonly DeployCheckConfig[], phase: ClearancePhase, run: CheckRun): Promise<ChecksAnswer> {
  let tag: string | undefined;
  for (const check of checks) {
    const output = new CheckOutput();
    const end = await run.hooks.run({
      argv: check.command,
      cwd: run.cwd,
      env: { ...run.env, TEAMRIG_CHECK_NAME: check.name, TEAMRIG_CHECK_PHASE: phase },
      timeoutMs: run.timeoutSeconds * 1000,
      onLine: output.hear,
    });
    const readiness = checkReadiness(check.name, end, output.reason === undefined ? undefined : shownLine(run.scanner, output.reason), run.timeoutSeconds);
    if (readiness.kind !== 'go') {
      return { readiness, tag: undefined };
    }
    tag = output.tag ?? tag;
  }
  return { readiness: { kind: 'go' }, tag };
}
