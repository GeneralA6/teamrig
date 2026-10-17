/**
 * The helper default, said in rule 8 and again at each helper launch: work in your own session, and start a
 * helper only when it keeps far more than its own cost out of your context or truly runs in parallel. A helper's
 * tokens count `budget.subagentWeight` times a main session's against the weekly limit (T369 measured about 2.2),
 * so the factor comes from the team's config.
 */
/** The weight as the rules print it: at most two decimals, so 2.15 stays 2.15 and the rule pack's size stays bounded. */
export function formatWeight(weight) {
    return String(Math.round(weight * 100) / 100);
}
/** When a helper pays, as the clause after "work in your own session:", with the config key it reads. */
export function helperDefaultClause(weight) {
    const cost = weight > 1
        ? `a helper's tokens cost ${formatWeight(weight)}x yours [budget.subagentWeight], so start one only when it keeps far more than that out of your context`
        : 'start a helper only when it keeps far more tokens out of your context than it uses';
    return `${cost} or truly runs in parallel, never for a build or test whose result you need`;
}
/**
 * The line the model gets at each helper launch (PreToolUse on the Agent tool). Claude Code hands it over with the
 * launch's result, after the helper started, so it speaks of the next one.
 */
export function helperLaunchReminder(weight) {
    return `teamrig rule 8: work in your own session: ${helperDefaultClause(weight)}. A broad read that returns a short answer is the case that pays; weigh the next helper the same way.`;
}
