/** `Tool` or `Tool(body)`; the body may hold anything, parentheses too. */
const RULE_SHAPE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s;
/** The tools a class names; any other tool's rules count as `other`, so a class never carries a rule's own text. */
const NAMED_TOOLS = new Set([
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
function parseRule(rule) {
    const match = RULE_SHAPE.exec(rule);
    const tool = match?.[1];
    return tool === undefined ? undefined : { tool, body: match?.[2] };
}
/** The tools whose rule body is a command line. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/**
 * A leading assignment that only stops Git for Windows' shell from rewriting path-like arguments, so a shell rule with
 * it approves what the same rule without it does (security's keep-list shape, T1037).
 */
const PATH_CONVERSION_OFF = 'MSYS_NO_PATHCONV=1 ';
/**
 * The rule as the keep-list compares it: a trailing `:*` reads as ` *`, the same prefix match, and a shell rule's one
 * leading `MSYS_NO_PATHCONV=1 ` reads as absent.
 */
export function normalRule(rule) {
    const parsed = parseRule(rule);
    if (parsed?.body === undefined) {
        return rule;
    }
    const command = SHELL_TOOLS.has(parsed.tool) && parsed.body.startsWith(PATH_CONVERSION_OFF) ? parsed.body.slice(PATH_CONVERSION_OFF.length) : parsed.body;
    return `${parsed.tool}(${command.endsWith(':*') ? `${command.slice(0, -2)} *` : command})`;
}
/** Approves a whole tool or a program with any arguments: a bare tool name or a `*` in the body; a rule of no known shape too. */
export function isToolWide(rule) {
    const parsed = parseRule(rule);
    return parsed?.body === undefined || parsed.body.includes('*');
}
/**
 * Holds a value one of the secret shapes matches. The rule is read as the keep-list reads it, so the prefix rule
 * `Bash(kubectl get secret:*)` is not taken for a `secret:` assignment.
 */
export function holdsCredential(rule, secrets) {
    return secrets.find(normalRule(rule)) !== undefined;
}
/**
 * The class a rule is counted under: its tool (a named one, `mcp`, `other`, or `unreadable`), and `credential`, `wide`
 * or `exact`. A credential comes first: it is a reason to remove the rule whatever the rule approves.
 */
export function ruleClass(rule, secrets) {
    const parsed = parseRule(rule);
    const tool = parsed === undefined ? 'unreadable' : parsed.tool.startsWith(MCP_PREFIX) ? 'mcp' : NAMED_TOOLS.has(parsed.tool) ? parsed.tool : 'other';
    const kind = holdsCredential(rule, secrets) ? 'credential' : isToolWide(rule) ? 'wide' : 'exact';
    return `${tool} ${kind}`;
}
/** The team's `permissions.keepAllow` list: a rule on it stays, and a kept `Tool(x *)` keeps `Tool(x)` too. */
export class KeepList {
    kept;
    constructor(rules) {
        this.kept = new Set(rules.map(normalRule));
    }
    keeps(rule) {
        const normal = normalRule(rule);
        if (this.kept.has(normal)) {
            return true;
        }
        const parsed = parseRule(normal);
        return parsed?.body !== undefined && !parsed.body.includes('*') && this.kept.has(`${parsed.tool}(${parsed.body} *)`);
    }
}
function countByClass(rules, secrets) {
    return mergeCounts([rules.map((rule) => [ruleClass(rule, secrets), 1])]);
}
/** Several class counts added up, largest first, then by name. */
export function mergeCounts(all) {
    const counts = new Map();
    for (const [name, count] of all.flat()) {
        counts.set(name, (counts.get(name) ?? 0) + count);
    }
    return [...counts].sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName));
}
/** The total of class counts. */
export function countOf(counts) {
    return counts.reduce((total, [, count]) => total + count, 0);
}
/** Splits an allow list into what a trim keeps and what it removes; a rule on the keep-list always stays. */
export function planAllowTrim(allow, keep, mode, secrets) {
    const removes = (rule) => !keep.keeps(rule) && (mode === 'all' || isToolWide(rule) || holdsCredential(rule, secrets));
    const after = allow.filter((rule) => !removes(rule));
    const listed = after.filter((rule) => keep.keeps(rule));
    return {
        after,
        listed,
        keptOther: countByClass(after.filter((rule) => !keep.keeps(rule)), secrets),
        removed: countByClass(allow.filter(removes), secrets),
    };
}
/** Class counts as text, such as `Bash wide 17, WebFetch exact 50`. */
export function formatCounts(counts) {
    return counts.map(([name, count]) => `${name} ${count}`).join(', ');
}
