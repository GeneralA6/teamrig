import type { RollGateConfig } from '../config/types.ts';
import type { ClearancePhase, Readiness } from '../coordinator/clearance.ts';
import type { Env } from '../core/home.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { HookEnd, HookRunner } from './hooks.ts';

/** A gate's exit codes: go, wait (`EX_TEMPFAIL`) and refuse; any other end makes the roll wait, so a broken gate never lets it through. */
export const GATE_GO_EXIT = 0;
export const GATE_WAIT_EXIT = 75;
export const GATE_REFUSE_EXIT = 2;

/** A stdout line that names what the roll deploys, such as an image tag; the last one wins. */
const TAG_LINE = /^tag=([A-Za-z0-9._:-]{1,128})$/;

/** A line a hook printed, once redacted, is cut to this many characters where others read it. */
export const HOOK_LINE_MAX_CHARS = 300;

/** What a gate printed that the roll reads: its first line that is not a tag (its reason), and its last tag. */
export class GateOutput {
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

/** What a gate's end means for the roll: its exit code read as go, wait or refuse; any other end waits. */
export function gateReadiness(name: string, end: HookEnd, reason: string | undefined, timeoutSeconds: number): Readiness {
  const because = reason === undefined ? '' : `: ${reason}`;
  switch (end.kind) {
    case 'exited':
      if (end.code === GATE_GO_EXIT) {
        return { kind: 'go' };
      }
      if (end.code === GATE_REFUSE_EXIT) {
        return { kind: 'refuse', reason: `gate ${name} refuses the roll${because}` };
      }
      if (end.code === GATE_WAIT_EXIT) {
        return { kind: 'wait', reason: `gate ${name} holds the roll${because}` };
      }
      return { kind: 'wait', reason: `gate ${name} failed (exit ${end.code}), so the roll waits${because}` };
    case 'timedOut':
      return { kind: 'wait', reason: `gate ${name} gave no answer within ${timeoutSeconds} s, so the roll waits` };
    case 'signal':
      return { kind: 'wait', reason: `gate ${name} was stopped by ${end.signal}, so the roll waits` };
    case 'notStarted':
      return { kind: 'wait', reason: `gate ${name} could not start (${end.error}), so the roll waits` };
    case 'stopped':
      return { kind: 'wait', reason: `gate ${name} was killed when its launching shell ended, so the roll waits` };
  }
}

export interface GateRun {
  readonly hooks: HookRunner;
  readonly scanner: Pick<SecretScanner, 'redact'>;
  readonly cwd: string;
  /** Every hook's environment: this process's, with the roll's `TEAMRIG_*` variables. */
  readonly env: Env;
  readonly timeoutSeconds: number;
}

/** The gates' answer: the first that does not pass, else go with the last tag a gate printed. */
export type GatesAnswer = { readonly readiness: Readiness; readonly tag: string | undefined };

/**
 * Asks each gate in order, with `TEAMRIG_GATE_NAME` and `TEAMRIG_GATE_PHASE` set, and stops at the first that does
 * not pass. Each reason is redacted, since a wait or refusal is printed and may reach the ledger.
 */
export async function askGates(gates: readonly RollGateConfig[], phase: ClearancePhase, run: GateRun): Promise<GatesAnswer> {
  let tag: string | undefined;
  for (const gate of gates) {
    const output = new GateOutput();
    const end = await run.hooks.run({
      argv: gate.command,
      cwd: run.cwd,
      env: { ...run.env, TEAMRIG_GATE_NAME: gate.name, TEAMRIG_GATE_PHASE: phase },
      timeoutMs: run.timeoutSeconds * 1000,
      onLine: output.hear,
    });
    const readiness = gateReadiness(gate.name, end, output.reason === undefined ? undefined : shownLine(run.scanner, output.reason), run.timeoutSeconds);
    if (readiness.kind !== 'go') {
      return { readiness, tag: undefined };
    }
    tag = output.tag ?? tag;
  }
  return { readiness: { kind: 'go' }, tag };
}
