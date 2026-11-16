import { toolCommandReadings } from "../core/bash-tool-readings.js";
import { parseIssueTarget, targetText } from "../issues/host.js";
import { readable } from "../slash/plan.js";
import { matchesKit } from "./route-kit.js";
import { plainWordsOf } from "./route-line.js";
import { isIssueCommand } from "./service-commands.js";
import { shipCallOf } from "./ship-role-call.js";
/**
 * The call shapes a service role lets run (T2984, design 1): each table command as the CLI's own parser reads it, with
 * typed slots and no wildcard. `teamrig issue close <owner/name#n> [--comment "<text>"]` and `teamrig issue comment
 * <owner/name#n> --body "<text>"`, through this install's own launcher, on a repository of `github.repos`, as one plain
 * command. The route gate (route-line.ts) refuses `#` and every joining character even inside quotes, which an issue
 * target and a comment need, so this reader masks exactly those parts first, after proving them literal to bash: the
 * target word as `owner/name#n` (a `#` inside a word starts no comment), and each double-quoted text holding no `"`,
 * `\`, `$`, backtick or control character (bash expands nothing in it). A line with a single quote or a backslash
 * outside such a text is no role call: the mask could not tell where bash's quotes end. A queued ship or merge is read
 * in the ship tool's own shape (ship-role-call.ts), through the same mask.
 */
/** The shape of each issue command; a new table entry adds its shape here, with a security review. */
const SHAPES = {
    'issue close': { commands: ['issue close'], options: ['session', 'comment'], positionals: 'one' },
    'issue comment': { commands: ['issue comment'], options: ['session', 'body'], positionals: 'one' },
};
/** A double-quoted text bash takes as it reads: nothing it expands, escapes or ends. */
const LITERAL_TEXT = /^[^"\\$`\p{Cc}]*$/u;
/** An issue target as a word of its own, its `#` the one the mask hides. */
const TARGET_WORD = /(?<=^|[ \t])([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})(?=[ \t]|$)/g;
/**
 * The line as the route gate's raw scan should read it for a role call: each literal double-quoted text as `"t"`, each
 * issue target's `#` as `_`; undefined when a quote or backslash outside such a text, or a quote that never closes,
 * leaves bash's reading of the line unclear.
 */
export function roleScanTextOf(line) {
    let scanned = '';
    for (let at = 0; at < line.length; at++) {
        const character = line.charAt(at);
        if (character === '\\' || character === "'") {
            return undefined;
        }
        if (character !== '"') {
            scanned += character;
            continue;
        }
        const end = line.indexOf('"', at + 1);
        if (end < 0 || !LITERAL_TEXT.test(line.slice(at + 1, end))) {
            return undefined;
        }
        scanned += '"t"';
        at = end;
    }
    return scanned.replace(TARGET_WORD, '$1_$2');
}
/** The flags whose text a role call posts on GitHub. */
const POSTED_FLAGS = ['comment', 'body'];
/**
 * Text a role call does not post unasked (T2984): a format or bidi character (`U+202E`, a zero-width space), a line
 * or paragraph separator, which can make a post read other than it is, or an @-mention, which pings someone outside
 * the team. The post still runs once the permission check lets it.
 */
const UNPOSTABLE = /[\p{Cf}\p{Zl}\p{Zp}]|(?<![\p{L}\p{N}_])@[\p{L}\p{N}]/u;
/** The role call `line` is, when it is one plain command of a table shape on a team repository; else undefined. */
export async function roleCallOf(line, context) {
    const scanned = roleScanTextOf(line);
    const words = scanned === undefined ? undefined : plainWordsOf(line, scanned);
    const parsed = words === undefined ? undefined : readable(words.slice(1), context.cli);
    const [program] = words ?? [];
    if (program !== undefined && parsed?.command === 'queue') {
        const ship = await shipCallOf(program, parsed, context);
        const session = parsed.flags.get('session');
        return ship === undefined || session === undefined ? undefined : { command: ship.merges ? 'queue merge' : 'queue ship', target: ship.worktree, session, ship };
    }
    if (words === undefined || parsed === undefined || !isIssueCommand(parsed.command)) {
        return undefined;
    }
    const command = parsed.command;
    const target = parseIssueTarget(parsed.positionals[0] ?? '');
    const session = parsed.flags.get('session');
    const posts = POSTED_FLAGS.map((flag) => parsed.flags.get(flag) ?? '');
    if (target === undefined || session === undefined || posts.some((text) => UNPOSTABLE.test(text))) {
        return undefined;
    }
    if (!context.repos.includes(target.repo) || !(await matchesKit(SHAPES[command], words, context))) {
        return undefined;
    }
    return { command, target: targetText(target), session };
}
/**
 * The role call a Bash tool call runs; undefined for any other tool or line. A call only when its shell may run one
 * text (`toolCommandReadings`): a second reading comes only from a backslash run, which no role call holds.
 */
export async function toolRoleCallOf(tool, line, platform, context) {
    const readings = toolCommandReadings(tool, line, platform);
    const [only] = readings;
    return tool !== 'Bash' || readings.length !== 1 || only === undefined ? undefined : roleCallOf(only, context);
}
