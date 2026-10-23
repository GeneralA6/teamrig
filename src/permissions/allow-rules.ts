/**
 * Claude Code's permission allow rules (`Tool` or `Tool(body)`), as `teamrig permissions trim` and the flags read
 * them. An allow rule approves a call before auto mode's classifier sees it, so a rule that approves a whole tool or a
 * program with any arguments (a bare tool name, or a `*` in the body) skips the one check that stops an injected or
 * mistaken action. A team keeps the rules on its `permissions.keepAllow` list. A rule's text can hold a value (a URI
 * with a password, a token), so a rule off that list is only ever counted by its class, never shown.
 */

/** `Tool` or `Tool(body)`; the body may hold anything, parentheses too. */
const RULE_SHAPE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s;

/** The tools a class names; any other tool's rules count as `other`, so a class never carries a rule's own text. */
const NAMED_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
  'Read',
  'Skill',
  'Task',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]);

/**
 * The shape of a rule on the keep-list: a tool, or a tool and a command with at most a trailing ` *` or `:*`. No other
 * `*`, no path or URL (`/`, `\`), no parenthesis and no line break, so a kept rule approves one command and its
 * arguments, never a program's every use or a file.
 */
export const KEEP_RULE_PATTERN = /^[A-Za-z][\w-]*(?:\([^*/\\()\r\n]+(?: \*|:\*)?\))?$/;

/** The prefix of an MCP tool's name; its rules count as one `mcp` class. */
const MCP_PREFIX = 'mcp__';

/** Which rules a trim removes: those that approve a whole tool or program, or every one off the keep-list. */
export type TrimMode = 'wide' | 'all';

interface ParsedRule {
  readonly tool: string;
  /** Undefined for a bare tool name. */
  readonly body: string | undefined;
}

function parseRule(rule: string): ParsedRule | undefined {
  const match = RULE_SHAPE.exec(rule);
  const tool = match?.[1];
  return tool === undefined ? undefined : { tool, body: match?.[2] };
}

/** The rule as the keep-list compares it: a trailing `:*` reads as ` *`, the same prefix match. */
export function normalRule(rule: string): string {
  const parsed = parseRule(rule);
  if (parsed?.body === undefined || !parsed.body.endsWith(':*')) {
    return rule;
  }
  return `${parsed.tool}(${parsed.body.slice(0, -2)} *)`;
}

/** Approves a whole tool or a program with any arguments: a bare tool name or a `*` in the body; a rule of no known shape too. */
export function isToolWide(rule: string): boolean {
  const parsed = parseRule(rule);
  return parsed?.body === undefined || parsed.body.includes('*');
}

/** The class a rule is counted under: its tool (a named one, `mcp`, `other`, or `unreadable`), and `wide` or `exact`. */
export function ruleClass(rule: string): string {
  const parsed = parseRule(rule);
  const tool = parsed === undefined ? 'unreadable' : parsed.tool.startsWith(MCP_PREFIX) ? 'mcp' : NAMED_TOOLS.has(parsed.tool) ? parsed.tool : 'other';
  return `${tool} ${isToolWide(rule) ? 'wide' : 'exact'}`;
}

/** The team's `permissions.keepAllow` list: a rule on it stays, and a kept `Tool(x *)` keeps `Tool(x)` too. */
export class KeepList {
  private readonly kept: ReadonlySet<string>;

  constructor(rules: readonly string[]) {
    this.kept = new Set(rules.map(normalRule));
  }

  keeps(rule: string): boolean {
    const normal = normalRule(rule);
    if (this.kept.has(normal)) {
      return true;
    }
    const parsed = parseRule(normal);
    return parsed?.body !== undefined && !parsed.body.includes('*') && this.kept.has(`${parsed.tool}(${parsed.body} *)`);
  }
}

/** Rules counted by class, largest first, then by name. */
export type ClassCounts = readonly (readonly [string, number])[];

/** What a trim leaves of one allow list. */
export interface AllowTrim {
  /** The rules that stay, in their order. */
  readonly after: readonly string[];
  /** The kept rules that are on the keep-list; their text is safe to show. */
  readonly listed: readonly string[];
  /** The other kept rules (the exact ones off the list, when only the wide ones go), by class. */
  readonly keptOther: ClassCounts;
  /** The removed rules, by class. */
  readonly removed: ClassCounts;
}

function countByClass(rules: readonly string[]): ClassCounts {
  return mergeCounts([rules.map((rule): readonly [string, number] => [ruleClass(rule), 1])]);
}

/** Several class counts added up, largest first, then by name. */
export function mergeCounts(all: readonly ClassCounts[]): ClassCounts {
  const counts = new Map<string, number>();
  for (const [name, count] of all.flat()) {
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return [...counts].sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName));
}

/** The total of class counts. */
export function countOf(counts: ClassCounts): number {
  return counts.reduce((total, [, count]) => total + count, 0);
}

/** Splits an allow list into what a trim keeps and what it removes. */
export function planAllowTrim(allow: readonly string[], keep: KeepList, mode: TrimMode): AllowTrim {
  const removes = (rule: string): boolean => !keep.keeps(rule) && (mode === 'all' || isToolWide(rule));
  const after = allow.filter((rule) => !removes(rule));
  const listed = after.filter((rule) => keep.keeps(rule));
  return {
    after,
    listed,
    keptOther: countByClass(after.filter((rule) => !keep.keeps(rule))),
    removed: countByClass(allow.filter(removes)),
  };
}

/** Class counts as text, such as `Bash wide 17, WebFetch exact 50`. */
export function formatCounts(counts: ClassCounts): string {
  return counts.map(([name, count]) => `${name} ${count}`).join(', ');
}
