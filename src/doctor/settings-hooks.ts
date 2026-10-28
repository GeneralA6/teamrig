import { isRecord, type JsonRecord } from '../core/guards.ts';

/** A `command` hook of a Claude Code settings object: its event, its command and, in the exec form, its `args`. */
export interface HookCommand {
  readonly event: string;
  readonly command: string;
  /** The exec form's arguments, which Claude Code passes to `command` without a shell; empty for a command line. */
  readonly args: readonly string[];
}

function argsOf(handler: JsonRecord): string[] {
  const args = handler['args'];
  return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [];
}

/** The `command` hooks of `events` in that order, each event's in file order; every event's when `events` is undefined. */
export function hookCommandsOf(settings: JsonRecord, events?: readonly string[]): HookCommand[] {
  const hooks = settings['hooks'];
  if (!isRecord(hooks)) {
    return [];
  }
  return (events ?? Object.keys(hooks)).flatMap((event) => {
    const groups: readonly unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const handlers = groups.flatMap((group): readonly unknown[] => (isRecord(group) && Array.isArray(group['hooks']) ? group['hooks'] : []));
    return handlers.flatMap((handler) => (isRecord(handler) && typeof handler['command'] === 'string' ? [{ event, command: handler['command'], args: argsOf(handler) }] : []));
  });
}

/** What a hook runs as one line: its command, then each argument, quoted when it holds a space. */
export function hookCommandLine(hook: HookCommand): string {
  return [hook.command, ...hook.args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' ');
}
