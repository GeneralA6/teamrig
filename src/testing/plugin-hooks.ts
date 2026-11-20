import { readFileSync } from 'node:fs';
import { isRecord, isStringArray, stringField, type JsonRecord } from '../core/guards.ts';

/** One hook the plugin's `hooks/hooks.json` wires to a host event. */
export interface WiredHook {
  readonly event: string;
  /** Which of the event's inputs reach the hook; undefined when its group has none, so all do. */
  readonly matcher: string | undefined;
  /** The words after the script in the hook's `args`: what teamrig's CLI is run with. */
  readonly argv: readonly string[];
}

/** The input field Claude Code compares a matcher with, by event; an event not listed takes no matcher. */
const MATCHED_FIELD: Readonly<Record<string, string>> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PostToolUseFailure: 'tool_name',
  PermissionRequest: 'tool_name',
  SessionStart: 'source',
  PreCompact: 'trigger',
  PostCompact: 'trigger',
};

/** A matcher that is one exact name or several with `|` between them, the only form this reader decides. */
const NAME_LIST = /^[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)*$/;

function listOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`hooks.json: ${what} is not a list`);
  }
  return value.map((item: unknown) => item);
}

/**
 * Every hook a parsed `hooks/hooks.json` wires, in the manifest's order, which is the order Claude Code starts an
 * event's hooks in. Throws on a manifest of another shape, and on a hook that is not `node <script> <words...>`: a
 * replay runs teamrig's CLI with the words, so it could not run anything else.
 */
export function wiredHooks(manifest: unknown): readonly WiredHook[] {
  const events = isRecord(manifest) ? manifest['hooks'] : undefined;
  if (!isRecord(events)) {
    throw new Error('hooks.json has no "hooks" object');
  }
  return Object.entries(events).flatMap(([event, groups]) =>
    listOf(groups, event).flatMap((group) => {
      if (!isRecord(group)) {
        throw new Error(`hooks.json: a ${event} entry is not an object`);
      }
      const matcher = group['matcher'];
      if (matcher !== undefined && typeof matcher !== 'string') {
        throw new Error(`hooks.json: a ${event} matcher is not a text`);
      }
      return listOf(group['hooks'], `the "hooks" of a ${event} entry`).map((hook): WiredHook => {
        const args = isRecord(hook) ? hook['args'] : undefined;
        if (!isRecord(hook) || hook['type'] !== 'command' || hook['command'] !== 'node' || !isStringArray(args) || args.length < 2) {
          throw new Error(`hooks.json: a ${event} hook is not a node command with a script and its words`);
        }
        return { event, matcher, argv: args.slice(1) };
      });
    }),
  );
}

/** The hooks the plugin's own `hooks/hooks.json` wires. */
export function pluginHooks(): readonly WiredHook[] {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../../plugins/teamrig/hooks/hooks.json', import.meta.url), 'utf8'));
  return wiredHooks(manifest);
}

/**
 * Whether Claude Code would run `hook` for the hook input `input`: the input is of the hook's event, and the hook has
 * no matcher, an empty one or `*`, or its matcher lists the input's tool (a tool event), `source` (SessionStart) or
 * `trigger` (a compaction event) by its exact name.
 *
 * Throws on any other matcher, and on a matcher at an event that takes none: how Claude Code reads a matcher that is
 * a real regular expression is not known here, and a guess would replay a hook the host never runs, or skip one it
 * does.
 */
export function hookMatches(hook: WiredHook, input: JsonRecord): boolean {
  const all = hook.matcher === undefined || hook.matcher === '' || hook.matcher === '*';
  const field = MATCHED_FIELD[hook.event];
  if (!all && field === undefined) {
    throw new Error(`hooks.json: ${hook.event} takes no matcher, and has "${hook.matcher ?? ''}"`);
  }
  if (!all && !NAME_LIST.test(hook.matcher ?? '')) {
    throw new Error(`hooks.json: the ${hook.event} matcher "${hook.matcher ?? ''}" is no list of exact names`);
  }
  if (stringField(input, 'hook_event_name') !== hook.event) {
    return false;
  }
  if (all || field === undefined) {
    return true;
  }
  const value = stringField(input, field);
  return value !== undefined && (hook.matcher ?? '').split('|').includes(value);
}
