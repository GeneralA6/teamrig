import { KIT_NAME } from "../../core/home.js";
import { meetCardLines } from "../../meeting/meet.js";
import { WAKE_TICK_MS } from "../../mod/wake-hand.js";
import { meetAsk, meetPrompt } from "../../open/prompt.js";
import { ownerCardsBySession } from "../../register/owner-waits.js";
import { onePositional, UsageError } from "../args.js";
import { readRunFiles } from "../hand-step-file.js";
import { callerOf } from "../inputs.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { runningRecordOf } from "../live-run.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRanking } from "../team-ranking.js";
import { teamRegister } from "../team-register.js";
import { postAtOnce } from "../urgent-line.js";
import { openSession, printOpenResult, terminalFlag } from "./open.js";
import { taskTreeOf } from "./register.js";
import { sessionProjectOf } from "./setup.js";
const NO_CARDS = { due: [], later: [] };
const SECOND_MS = 1000;
/**
 * The session `ref` names (an id or a name) and its cards on the owner; refused when no card of it waits on the owner
 * now, naming the cards the owner put off and until when.
 */
async function meetFactsOf(runtime, ref) {
    const found = await findTeam(runtime);
    const kit = await openKit(runtime, found.team);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const id = sessionIdOf(roster, ref);
    const name = roster.nameOf(id) ?? id;
    const { snapshot, elsewhere } = await teamRegister(runtime, kit.paths, config).snapshotWithElsewhere();
    const ranking = await teamRanking(runtime, kit.paths, config, snapshot.state.tasks.values());
    const tree = taskTreeOf({ snapshot, config, elsewhere, ranking }, runtime);
    const { ownerSource, requireDecisionCard } = config.register;
    const cards = ownerCardsBySession([...snapshot.state.tasks.values()], tree, ownerSource, requireDecisionCard).get(id) ?? NO_CARDS;
    if (cards.due.length === 0) {
        const later = cards.later.map((card) => `${card.task.id} until ${card.until}`);
        throw new RefusedError(`${name} (session ${id}) has no card waiting on ${ownerSource} now${later.length === 0 ? '' : `; put off: ${later.join(', ')}`}`);
    }
    return { found, kit, config, roster, id, name, cards, tree };
}
/**
 * Asks the running session met to bring its cards, and returns what that prints (T2207). The owner waits on it live,
 * so the ask is due at once, not after the `wake.batchSeconds` a plain ask waits; while one still waits, nothing more
 * is posted (postAtOnce).
 */
async function wakeToMeet(runtime, facts) {
    const { kit, config, id, name } = facts;
    const owner = config.register.ownerSource;
    const posted = await postAtOnce(runtime, kit, config, { to: id, from: owner, text: meetAsk(id, owner) }, `${name} (session ${id})`);
    if (posted.kind === 'waiting') {
        const at = teamZone(config, runtime).clock(new Date(posted.at));
        return `ASKED ${name} (session ${id}) at ${at}: that ask still waits for its tab to be idle (a running turn ends first), so no second line was posted`;
    }
    const within = Math.ceil(WAKE_TICK_MS / SECOND_MS);
    return `WAKES ${name} (session ${id}) within about ${within} s once its tab is idle (a running turn ends first): ${facts.cards.due.length} card(s) waiting on ${owner}; an inbox line asks it to bring them now`;
}
/** `meet --cards [--session <id|name>]`: the caller's cards due on the owner, and how to bring them and record each answer. */
async function meetCards(args, runtime) {
    const [extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`meet --cards prints the caller's own cards: it takes no "${extra}"`);
    }
    const { id, name, cards, tree, config } = await meetFactsOf(runtime, callerOf(args.flags, runtime.env));
    const runFiles = await readRunFiles(runtime, cards.due);
    const lines = meetCardLines({ id, name, cards, tree, ownerMarker: config.register.ownerSource, command: KIT_NAME, runFiles });
    lines.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/**
 * `meet <id|name> [--terminal <name>] [--project <dir>]`: the owner meets one session on its cards waiting on them
 * (T1295). A running session gets an inbox line that wakes its tab at once, unless such an ask still waits
 * (wakeToMeet); any other opens fresh in a new tab, its context only the meeting. Both ask it to run `meet --cards`.
 * Refused when no card of it waits on the owner now.
 */
export async function meet(args, runtime) {
    if (args.switches.has('cards')) {
        return meetCards(args, runtime);
    }
    const facts = await meetFactsOf(runtime, onePositional(args, 'id|name'));
    const { found, kit, config, roster, id } = facts;
    if ((await runningRecordOf(runtime, kit.paths, roster.ids, id)) !== undefined) {
        runtime.out.stdout(await wakeToMeet(runtime, facts));
        return EXIT.ok;
    }
    const terminal = terminalFlag(args.flags.get('terminal')) ?? config.open.terminal;
    const project = await sessionProjectOf(runtime, config, id, args.flags.get('project'), found.from);
    const team = found.team;
    // The meeting tab is the one the owner asked for, so it takes the focus even while a meeting is open (T2510).
    const opened = await openSession(runtime, kit, config, roster, { team, id, project, terminal, asked: false, focus: 'take', fresh: true, prompt: meetPrompt(team, id, config.register.ownerSource) });
    return printOpenResult(runtime, opened);
}
