import { findClaude } from "../open/claude.js";
import { hookEndText, succeeded } from "../deploy/hooks.js";
/** Measured 29 to 61 s on 2.1.312 (10-28), all of it Claude Code starting: the command itself calls no model. */
export const SKILL_DOCTOR_TIMEOUT_MS = 120_000;
/** `/skill-doctor` headless and read only: no hook runs, no MCP server or browser starts, no session is saved. */
export const SKILL_DOCTOR_ARGS = [
    '-p',
    '/skill-doctor',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--no-chrome',
    '--settings',
    '{"disableAllHooks":true}',
];
const HEADER = /^\s*skill\s{2,}source\s{2,}context\s{2,}7d tokens\s{2,}uses\s{2,}last used\s*$/;
/** Columns are padded apart by two spaces or more; a value holds one space at most (`claude.ai sync`, `< 20`). */
const COLUMN_GAP = /\s{2,}/;
/** `~50`, `< 20` (counted as 20) or `120`; `-` is a skill not in the listing. */
const LISTED = /^(?:~|<\s*)?(\d+)$/;
const USES = /^(\d+)[×x]$/;
const DAYS_AGO = /^(\d+) days?$/;
function listedOf(text) {
    if (text === '-') {
        return 0;
    }
    const match = LISTED.exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]);
}
function lastUsedDaysOf(text) {
    if (text === 'today') {
        return 0;
    }
    const match = DAYS_AGO.exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]);
}
function rowOf(line) {
    const [name, source, context, , uses, lastUsed, ...rest] = line.trim().split(COLUMN_GAP);
    if (name === undefined || source === undefined || context === undefined || uses === undefined || lastUsed === undefined || rest.length > 0) {
        return undefined;
    }
    const listed = listedOf(context);
    const count = USES.exec(uses)?.[1];
    if (listed === undefined || count === undefined) {
        return undefined;
    }
    return { name, source, listed, uses: Number(count), lastUsedDays: lastUsedDaysOf(lastUsed) };
}
/** The table's rows, from its header to the first blank line, leaving out a row it cannot read; undefined with no table. */
export function parseSkillDoctor(lines) {
    const header = lines.findIndex((line) => HEADER.test(line));
    if (header === -1) {
        return undefined;
    }
    const rows = [];
    for (const line of lines.slice(header + 1)) {
        if (line.trim() === '') {
            break;
        }
        const row = rowOf(line);
        if (row !== undefined) {
            rows.push(row);
        }
    }
    return rows;
}
/** `/skill-doctor` through the Claude Code on PATH, run in the project's folder so its skills are listed too. */
export function claudeSkillDoctor(deps) {
    return {
        async read(project) {
            const found = await findClaude(deps);
            if (found.kind === 'missing') {
                return { kind: 'skipped', why: 'Claude Code is not on PATH' };
            }
            const lines = [];
            const { command, prefix } = found.program;
            const end = await deps.hooks.run({
                argv: [command, ...prefix, ...SKILL_DOCTOR_ARGS],
                cwd: project,
                env: deps.env,
                timeoutMs: SKILL_DOCTOR_TIMEOUT_MS,
                onLine: (line) => lines.push(line),
            });
            if (!succeeded(end)) {
                return { kind: 'skipped', why: `claude -p /skill-doctor ${hookEndText(end)}` };
            }
            const skills = parseSkillDoctor(lines);
            return skills === undefined ? { kind: 'skipped', why: 'claude -p /skill-doctor printed no skill table' } : { kind: 'read', skills };
        },
    };
}
