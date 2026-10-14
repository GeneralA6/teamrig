/** The rendered core pack fits in this many characters with worst-case config values (a CI test holds it). */
export const CORE_PACK_MAX_CHARS = 6_000;
/** The team's own rules file is shown in full only up to this size; a longer one gets a pointer. */
export const TEAM_RULES_MAX_CHARS = 3_500;
/** Claude Code caps a SessionStart hook's `additionalContext` at this size. */
export const CONTEXT_MAX_CHARS = 10_000;
function list(items) {
    return items.join('; ');
}
/** At most two decimals, so float noise (0.30000000000000004) or a tiny value (1e-7) prints short. */
function percent(value) {
    return `${Math.round(value * 100) / 100}%`;
}
/** The note, evidence and skill a status change needs, as the register enforces them. */
function statusDemands(config, command) {
    const { register } = config;
    const demands = [
        register.requireNoteOn.length === 0 ? '' : `a note on ${register.requireNoteOn.join(', ')} [register.requireNoteOn]`,
        register.requireEvidenceOnDone ? 'evidence on done [register.requireEvidenceOnDone]' : '',
        register.requireSkillOnDone ? `--skill <name> or --skill none on done [register.requireSkillOnDone]` : '',
    ].filter((demand) => demand !== '');
    return `only the owning session sets its status (\`${command} set\`)${demands.length === 0 ? '' : `, with ${demands.join(', ')}`}.`;
}
/**
 * The always-loaded core rules, filled from the team's config. Each rule names the config key
 * behind any value it prints, so a team changes a number without forking the text.
 */
export function renderCorePack(config, command) {
    const { roles, skills } = config;
    const { budget } = config.coordinator;
    const cutoff = config.coordinator.schedule.heavyCutoffUtc;
    const rules = [
        `Roles, by session id (\`${command} who\` gives the name to message each by): ${roles.lead} is the lead: priorities, team rules and the owner's decision queue; it may re-tier and reassign tasks [roles.lead].` +
            (roles.coordinatorOwner === undefined ? '' : ` ${roles.coordinatorOwner} owns deploy coordination and fleet health [roles.coordinatorOwner].`) +
            ' Every other session owns its area.',
        "Own your change end to end: only the session that made a change integrates it, deploys it when it must run, verifies that it runs, and fixes or rolls it back. Never integrate, verify or fix another session's change: hand it to its owner.",
        'A message wakes its receiver, so send one only for a result it consumes, a decision, a blocker, a same-area conflict or an incident.' +
            ` At most ${config.messages.maxLines} lines [messages.maxLines]: what happened, evidence (numbers, ids, paths), the exact ask and deadline, your default, then "No reply needed" or "Reply needed: <one question>".` +
            ` No acks, thanks or progress pings. Anything non-urgent is one inbox line: \`${command} inbox add --to <area> --text "..."\`.`,
        `Status is pulled, never asked: each session keeps one board and writes only its own. At the start of each work block run \`${command} inbox read --session <you>\`.` +
            ` Every ask that creates work is a register entry the asker adds in the same turn (\`${command} add --owner <session>\`); ${statusDemands(config, command)}`,
        `Silence is consent only within the sender's own authority, never for owner-gated decisions: ${list(config.ownerGates)} [ownerGates].`,
        'Deploy ASAP means the earliest moment a change can be verified (tests, then a check that it runs). State each fix\'s evidence and when it will exist; build nothing on a fix before then.' +
            (cutoff === undefined ? '' : ` No heavy step (builds, test runs, data scripts) starts after ${cutoff} UTC [coordinator.schedule.heavyCutoffUtc].`),
        'Lean calls: every tool call re-reads the whole context, so batch related shell steps into one call, give broad searches and multi-file reading to a subagent that returns the conclusion, and run subagents on your own model and effort.' +
            (budget.enabled ? ` Pace the week to ${percent(budget.targetPct)} of the weekly limit and keep ${percent(budget.reservePct)} for incidents [coordinator.budget].` : ''),
        'Investigate before deciding: give frequency × impact and the cheapest fix for the visible symptom. Questions for the owner come with options, numbers and a recommendation; a question with one correct answer is yours to decide.',
        'Rising resource use (memory, CPU, storage, tokens) needs its root cause; a raised limit is only an owner-approved bridge with a dated root-cause task.',
        'Code that writes data ships a read-only dry run (inserted, unchanged, changed counts). Deleting derived data needs a verified regenerate tool and a parity run first.',
        `Tell the other side before changing a contract it reads (an API parameter, a shared table or file). The same external failure for ${config.alerts.persistentFailureHours} h must page a human [alerts.persistentFailureHours].`,
        `A procedure you had to investigate and will run again becomes a skill in the same turn: \`<area>-<name>/SKILL.md\`, shared ones \`${skills.sharedPrefix}-<name>\` [skills.sharedPrefix].` +
            ` Its description has at most ${skills.maxDescriptionWords} words [skills.maxDescriptionWords]; its body has \`Owner:\` and \`Last verified:\` lines, re-verified every ${skills.maxVerifiedAgeDays} days [skills.maxVerifiedAgeDays];` +
            ` at most ${skills.maxPerArea} per area [skills.maxPerArea]` +
            (skills.forbidFrontmatter.length === 0 ? '' : `; never ${skills.forbidFrontmatter.join(', ')} [skills.forbidFrontmatter]`) +
            '. Memory holds facts, skills hold how-tos, CLAUDE.md holds every-turn rules.',
        'One logical change per commit (a fix with its tests, a refactor apart from what it enables, a mechanical change alone), committed as each step passes.' +
            ` Over ${config.commits.maxLines} changed non-test lines or ${config.commits.maxFiles} non-test files [commits.maxLines, commits.maxFiles], a commit needs a \`${config.commits.largeCommitTrailer}: <reason>\` line [commits.largeCommitTrailer]` +
            { off: '.', warn: '; a push to a protected branch lists those without one [commits.gate].', refuse: '; a push to a protected branch that sends one is refused [commits.gate].' }[config.commits.gate],
        `Pushes to ${list(config.pushGuard.protectedBranches)} ask the human; force-pushing or deleting them is refused [pushGuard.protectedBranches]. A refused or blocked route is reported to the lead, never routed around.`,
        'Edit in your own worktree and branch in every git repo, never a main checkout. On Windows remove a worktree\'s node_modules link (`cmd /c rmdir`; Git Bash `cmd //c`), or `git worktree remove` follows it into the main one. Whoever finds a stale comment, doc or dead code fixes it in its own small commit.',
    ];
    return [
        '# Team rules (teamrig core)',
        "Where your team's rules or CLAUDE.md conflict with these, yours win. [brackets] name the config key behind a value.",
        '',
        ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    ].join('\n');
}
/** The SessionStart context: the core pack, then the team's rules in full when they fit, else a pointer. */
export function renderSessionContext(core, team, command) {
    const text = team?.text.trim() ?? '';
    if (team === undefined || text === '') {
        return core;
    }
    const full = `${core}\n\n# Your team's rules\n${text}`;
    if (text.length <= TEAM_RULES_MAX_CHARS && full.length <= CONTEXT_MAX_CHARS) {
        return full;
    }
    const pointer = `${core}\n\nYour team's rules are in ${team.path} (${text.length} characters, more than the ${TEAM_RULES_MAX_CHARS} shown here): read them now.`;
    return pointer.length <= CONTEXT_MAX_CHARS ? pointer : `${core}\n\nYour team's rules file is too long to show or point to here; run \`${command} doctor\`.`;
}
