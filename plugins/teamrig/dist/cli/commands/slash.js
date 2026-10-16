import { isRecord, stringField } from "../../core/guards.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { planSlash, SESSION_FLAG, sessionReads, withSession } from "../../slash/plan.js";
import { joinWords, splitWords } from "../../slash/words.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { parseJson, sessionTeam, teamSessionOf } from "./hook-input.js";
/**
 * Where a line counts as the person's own, by Claude Code's prompt origin (`PromptOrigin.kind`): Enter at
 * the tab's prompt, or a message through Remote Control. Every other origin (another session, a channel, a
 * schedule, a plugin, `claude -p`) may run reads only.
 */
const PERSON_ORIGINS = new Set(['composer', 'bridge']);
function slashInputOf(payload) {
    if (!isRecord(payload)) {
        return { args: '', origin: undefined, agreed: undefined };
    }
    return { args: stringField(payload, 'args') ?? '', origin: stringField(payload, 'origin'), agreed: stringField(payload, 'agreed') };
}
/** The tab's team and session, read as its hooks read them (hook-input.ts): `$TEAMRIG_SESSION`, else the area it read its inbox as or was bound to. */
async function tabOf(payload, runtime) {
    const found = await sessionTeam(payload, runtime);
    if (found.kind !== 'team') {
        return { kind: 'no-team' };
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return { kind: 'no-config', team: found.team };
    }
    const roster = await rosterOf(runtime, kit, kit.load.config);
    return { kind: 'team', team: found.team, session: await teamSessionOf(runtime, kit, roster, sessionIdOf(payload)) };
}
/**
 * The runtime a typed command runs in: the tab's team pinned, so the command reads the team the tab's
 * session belongs to even after a `cd` into another team's project, and an empty stdin, which this
 * hook has already read.
 */
function tabRuntime(runtime, tab) {
    const env = tab.kind === 'no-team' ? runtime.env : { ...runtime.env, [ENV.team]: tab.team };
    return { ...runtime, env, readStdin: () => Promise.resolve('') };
}
/** The lines `/teamrig` alone adds under the short help: what runs as the tab's session, and what asks first. */
export function slashRule(table) {
    return [
        `In a Claude Code tab, /${KIT_NAME} <command> runs it there. Without --${SESSION_FLAG}, ${sessionReads(table).join(', ')}`,
        `run as this tab's session; a command that changes the team's files shows the line with this tab's session`,
        `and asks first. Those run only when you type them, never when another session, a channel or claude -p sends them.`,
    ].join('\n');
}
/** Why a write that did not come from the person is not run. */
function notThePerson(argv, origin) {
    return `${KIT_NAME} ${joinWords(argv)} changes the team's files, and /${KIT_NAME} runs that only when you type it in the tab; this line came from ${origin ?? 'an unnamed source'}. Run it in a terminal instead.`;
}
/**
 * `hook slash-command`: answers `/teamrig <args>` in a Claude Code tab. The teamrig plugin's mod
 * (src/mod/slash-hand.ts) runs it with `{"session_id", "cwd", "args", "origin", "agreed"}` on stdin,
 * `args` being the text typed after the command and `origin` Claude Code's `PromptOrigin.kind`. It splits
 * the text as a shell would and runs the line through the CLI's own runner, in the tab's team:
 * - a read runs at once: as typed, or, given no `--session`, as the tab's session, one line above the
 *   output saying so;
 * - a write runs only when the person typed it (REFUSED, exit 2, from any other origin): as typed when it
 *   names its `--session` or takes none; else it prints the line with the tab's session and exits 4, and
 *   runs that line once the mod sends it back as `agreed`;
 * - a command Claude Code or teamrig runs itself is refused with exit 64.
 * A tab that is no team session runs the line as typed, after one note.
 */
export function slashCommand(deps) {
    return async (args, runtime) => {
        noPositionals(args);
        const payload = parseJson(await runtime.readStdin());
        const input = slashInputOf(payload);
        const words = splitWords(input.args);
        if (!words.ok) {
            runtime.out.stderr(deps.help.usageError(words.problem, undefined));
            return EXIT.usage;
        }
        const plan = planSlash(words.words, deps.table);
        if (plan.kind === 'help') {
            runtime.out.stdout(`${deps.help.forCommand(undefined)}\n${slashRule(deps.table)}`);
            return EXIT.ok;
        }
        if (plan.kind === 'internal') {
            runtime.out.stderr(deps.help.usageError(`${KIT_NAME} ${plan.command} is run by Claude Code or by ${KIT_NAME} itself, never from /${KIT_NAME}`, plan.command));
            return EXIT.usage;
        }
        if (plan.effect === 'write' && (input.origin === undefined || !PERSON_ORIGINS.has(input.origin))) {
            throw new RefusedError(notThePerson(plan.argv, input.origin));
        }
        const tab = await tabOf(payload, runtime);
        const inTab = tabRuntime(runtime, tab);
        if (plan.kind === 'as-typed') {
            return deps.run(plan.argv, inTab);
        }
        const session = tab.kind === 'team' ? tab.session : undefined;
        if (session === undefined) {
            if (tab.kind === 'team') {
                runtime.out.stdout(`This tab is no team session yet, so it runs without --${SESSION_FLAG}; /${KIT_NAME} inbox read --${SESSION_FLAG} <you> binds it.`);
            }
            return deps.run(plan.argv, inTab);
        }
        const filled = withSession(plan, session, deps.table);
        if (plan.effect === 'write') {
            const line = `${KIT_NAME} ${joinWords(filled)}`;
            if (input.agreed !== line) {
                runtime.out.stdout(line);
                return EXIT.ask;
            }
        }
        runtime.out.stdout(`--${SESSION_FLAG} ${session} (this tab's session)`);
        return deps.run(filled, inTab);
    };
}
