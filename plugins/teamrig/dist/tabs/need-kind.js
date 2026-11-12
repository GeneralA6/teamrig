/**
 * The kinds of ask a tab waits on (T2511), apart from the tab file store (need.ts) so the config parser, which the
 * read side runs without Node, reaches no file code: a permission prompt, a question or plan, an MCP form, a decision
 * line, an API error.
 */
export const NEED_KINDS = ['permission', 'question', 'elicitation', 'decision', 'error'];
const KINDS = new Set(NEED_KINDS);
export function isNeedKind(value) {
    return KINDS.has(value);
}
