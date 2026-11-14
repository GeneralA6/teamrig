import { resolve } from 'node:path';
import type { PathKind, PathProbe } from '../core/path-probe.ts';
import type { HiddenRequest, Processes, RunOutcome, RunRequest, StartOutcome, StartRequest } from '../open/processes.ts';
import { KEEP_FOCUS_PROGRAM_VAR } from '../open/keep-focus.ts';

/**
 * A host without Windows PowerShell, for `onRun('powershell.exe', NO_POWERSHELL)`: the script that keeps the focus cannot
 * run, so a Windows Terminal launcher then starts plainly and a spec sees its arguments in `started` (T2510).
 */
export const NO_POWERSHELL: RunOutcome = { kind: 'missing' };

/**
 * Processes that start nothing: each request is recorded, and the outcome is the one set for its
 * command (default: a launcher is missing, a program runs and exits 0, a hidden program starts).
 */
export class FakeProcesses implements Processes {
  readonly started: StartRequest[] = [];
  readonly ran: RunRequest[] = [];
  readonly hidden: HiddenRequest[] = [];
  private readonly startOutcomes = new Map<string, StartOutcome>();
  private readonly runOutcomes = new Map<string, RunOutcome>();

  /** The launchers started through the script that keeps the focus where it was (T2510), in order. */
  get keptFocus(): string[] {
    return this.ran.flatMap((request) => request.env[KEEP_FOCUS_PROGRAM_VAR] ?? []);
  }

  /** From now on, starting `command` gives `outcome`. */
  onStart(command: string, outcome: StartOutcome): this {
    this.startOutcomes.set(command, outcome);
    return this;
  }

  /** From now on, running `command` gives `outcome`. */
  onRun(command: string, outcome: RunOutcome): this {
    this.runOutcomes.set(command, outcome);
    return this;
  }

  async start(request: StartRequest): Promise<StartOutcome> {
    this.started.push(request);
    return this.startOutcomes.get(request.command) ?? { kind: 'missing' };
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    this.ran.push(request);
    return this.runOutcomes.get(request.command) ?? { kind: 'exited', code: 0 };
  }

  async startHidden(request: HiddenRequest): Promise<StartOutcome> {
    this.hidden.push(request);
    return this.startOutcomes.get(request.command) ?? { kind: 'started', end: 'spawned' };
  }
}

/** A filesystem of the given folders and files only, compared as resolved paths. */
export class FakePathProbe implements PathProbe {
  private readonly kinds = new Map<string, PathKind>();

  constructor(entries: { readonly folders?: readonly string[]; readonly files?: readonly string[] } = {}) {
    (entries.folders ?? []).forEach((path) => this.kinds.set(resolve(path), 'folder'));
    (entries.files ?? []).forEach((path) => this.kinds.set(resolve(path), 'file'));
  }

  async kind(path: string): Promise<PathKind> {
    return this.kinds.get(resolve(path)) ?? 'none';
  }
}
