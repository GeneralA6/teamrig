import { KIT_NAME } from "../../core/home.js";
import { meetCardLines } from "../../meeting/meet.js";
import { WAKE_TICK_MS } from "../../mod/wake-hand.js";
import { meetAsk, meetPrompt } from "../../open/prompt.js";
import { ownerCardsBySession } from "../../register/owner-waits.js";
import { measureSessions, runningPlaces } from "../../sessions/measure.js";
import { SessionRecordStore } from "../../sessions/record.js";
import { WakeAsks } from "../../wake/asks.js";
import { onePositional, UsageError } from "../args.js";
import { callerOf } from "../inputs.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRanking } from "../team-ranking.js";
import { teamRegister } from "../team-register.js";
import { postUrgentLine } from "../urgent-line.js";
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
/** Whether the session's Claude Code runs now; refused when the host's processes cannot be listed. */
async function isRunning(runtime, kit, roster, id) {
    // Every session's record: a later one on the same process (a /clear that bound the tab to it) wins it.
    const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids);
    const rows = await runtime.memory.processes();
    if (rows === undefined) {
        throw new RefusedError(`${KIT_NAME} could not list the host's processes, so it cannot tell whether ${id} runs`);
    }
    return runningPlaces(measureSessions(records, rows)).some((place) => place.id === id);
}
/**
 * Asks the running session met to bring its cards, and returns what that prints (T2207). The owner waits on it live,
 * so the ask is due at once, not after the `wake.batchSeconds` a plain ask waits. While a meet ask from the owner
 * still waits for its tab (busy in a turn, or the next wake check not yet run), nothing more is posted: a second press
 * would only put the same line in its inbox again.
 */
async function wakeToMeet(runtime, facts) {
    const { kit, config, id, name } = facts;
    const owner = config.register.ownerSource;
    const text = meetAsk(id, owner);
    const waiting = (await new WakeAsks(runtime.files, kit.paths.wakeAsks).read(id)).find(({ ask }) => ask?.from === owner && ask.text === text)?.ask;
    if (waiting !== undefined) {
        const at = teamZone(config, runtime).clock(new Date(waiting.at));
        return `ASKED ${name} (session ${id}) at ${at}: that ask still waits for its tab to be idle (a running turn ends first), so no second line was posted`;
    }
    const problem = await postUrgentLine(runtime, kit, config, { to: id, from: owner, text, atOnce: true });
    if (problem !== undefined) {
        throw new RefusedError(`${name} (session ${id}) was not woken: ${problem}`);
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
    const lines = meetCardLines({ id, name, cards, tree, ownerMarker: config.register.ownerSource, command: KIT_NAME, askWith: config.decisions.askWith });
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
    if (await isRunning(runtime, kit, roster, id)) {
        runtime.out.stdout(await wakeToMeet(runtime, facts));
        return EXIT.ok;
    }
    const terminal = terminalFlag(args.flags.get('terminal')) ?? config.open.terminal;
    const project = await sessionProjectOf(runtime, config, id, args.flags.get('project'), found.from);
    const team = found.team;
    const opened = await openSession(runtime, kit, config, roster, { team, id, project, terminal, asked: false, fresh: true, prompt: meetPrompt(team, id, config.register.ownerSource) });
    return printOpenResult(runtime, opened);
}
