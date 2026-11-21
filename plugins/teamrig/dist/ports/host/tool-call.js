/**
 * What a tool call is for, whatever the host names the tool: the core's guards and reminders ask for a kind and its
 * fields, never for a tool's name or the keys of its input. `task-input` is a host's own task list; `other` is every
 * tool the core has no rule for.
 */
export const TOOL_KINDS = ['shell', 'read', 'edit', 'search', 'web', 'helper', 'skill', 'ask', 'schedule', 'message', 'task-input', 'other'];
/** The shell languages a shell call's command is written in: a guard parses each by its own rules. */
export const SHELL_DIALECTS = ['bash', 'powershell'];
export function isToolKind(value) {
    return TOOL_KINDS.some((kind) => kind === value);
}
