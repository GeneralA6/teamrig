import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS } from '../config/limits.ts';
import type { ConfigLoad } from '../config/load.ts';
import { CONTEXT_MAX_CHARS, renderCorePack, TEAM_RULES_MAX_CHARS, type TeamRules } from '../rules/pack.ts';
import { testConfig } from '../testing/config.ts';
import { RULES_CLOCK } from '../testing/zone.ts';
import { renameOf } from '../testing/rename.ts';
import { sessionStartContext, sessionStartOutput, type CuttableNote, type SessionStartInput } from './session-start.ts';

const PATH = '/kit/teams/app/config.json';
const COMMAND = 'teamrig';
const NAMES = '`teamrig who` prints the name to message any session by; message only those names.';

function loaded(overrides: Partial<Extract<ConfigLoad, { status: 'loaded' }>> = {}): ConfigLoad {
  return { status: 'loaded', path: PATH, config: testConfig({ names: { lead: 'captain' } }), issues: [], ...overrides };
}

function context(overrides: Partial<SessionStartInput> = {}): string {
  return sessionStartContext({
    team: 'app',
    load: loaded(),
    teamRules: [],
    keptRulesAbove: [],
    renames: [],
    titleNote: undefined,
    refreshNote: undefined,
    liveTasksNote: undefined,
    modelNote: undefined,
    verifyNote: undefined,
    duplicateNote: undefined,
    worktreeNote: undefined,
    session: 'alpha',
    sessionInEnv: true,
    tree: undefined,
    command: COMMAND,
    platform: 'win32',
    clock: RULES_CLOCK,
    ...overrides,
  });
}

describe('sessionStartContext', () => {
  it("tells a sub-lead's member to message its own leader, and the sub-lead the lead", () => {
    const load = loaded({ config: testConfig({ names: { lead: 'captain', bravo: 'app-bravo' }, leads: { bravo: ['alpha'] } }) });
    const member = context({ load });
    assert.match(member, /Message your leader as `app-bravo`, who takes to the lead what it cannot settle\.\n/);
    assert.ok(!member.includes('Message the lead as'), member);
    assert.match(context({ load, session: 'bravo' }), /Message the lead as `captain`\.\n/);
    // Rule 3 names SendMessage; the lead is only never told a leader to message.
    assert.doesNotMatch(context({ load, session: 'lead' }), /\bMessage (the lead|your leader)\b/, 'the lead messages no leader');
  });

  it('sends a session to the inbox, not to messages, when its leader has a name Claude Code reserves', () => {
    const renames = [renameOf('lead', 'captain', 'team-lead')];
    const inbox = ' Write to the lead with `teamrig inbox add --to lead --text "..."`: its name `team-lead` is a name Claude Code keeps for itself, so a message sent to it never reaches a session.\n';
    for (const session of ['alpha', undefined]) {
      const text = context({ renames, session });
      assert.ok(text.includes(inbox), text);
      assert.ok(!text.includes('Message the lead as'), text);
    }
    const load = loaded({ config: testConfig({ names: { lead: 'captain', bravo: 'app-bravo' }, leads: { bravo: ['alpha'] } }) });
    const sub = context({ load, renames: [renameOf('bravo', 'app-bravo', 'main')] });
    assert.match(sub, / Write to your leader, who takes to the lead what it cannot settle, with `teamrig inbox add --to bravo --text "\.\.\."`: its name `main` is a name Claude Code keeps/);
  });

  it('gives the core rules, then who the session is and how to reach the lead', () => {
    const text = context();
    assert.ok(text.startsWith(renderCorePack(testConfig(), COMMAND, 'win32', RULES_CLOCK)));
    assert.ok(text.endsWith(`\n\nYou are the \`alpha\` session of team \`app\` (name \`app-alpha\`). Message the lead as \`captain\`.\n${NAMES}`));
  });

  it('renders the rules for the platform the hook runs on', () => {
    assert.ok(context({ platform: 'linux' }).startsWith(renderCorePack(testConfig(), COMMAND, 'linux', RULES_CLOCK)));
    assert.doesNotMatch(context({ platform: 'linux' }), /worktree remove/);
  });

  it('finds the session by name too, and tells the lead its role', () => {
    const text = context({ session: 'captain' });
    assert.ok(text.endsWith(`\n\nYou are the \`lead\` session of team \`app\` (name \`captain\`, roles: lead).\n${NAMES}`));
  });

  it('gives the lead its own lines after the core rules, and no other session', () => {
    const lead = context({ session: 'captain' });
    assert.ok(lead.includes('\n\nAs the lead, also:\n- Bring the owner only verified results'), lead);
    assert.ok(lead.indexOf('As the lead, also:') < lead.indexOf('You are the `lead` session'));
    assert.ok(!context({ session: 'alpha' }).includes('As the lead'));
  });

  it('tells a session known only by --session or by its inbox to pass --session', () => {
    assert.ok(
      context({ sessionInEnv: false }).endsWith(
        `\n\nYou are the \`alpha\` session of team \`app\` (name \`app-alpha\`). $TEAMRIG_SESSION is not set here, so pass --session alpha to every \`teamrig\` task and inbox command. Message the lead as \`captain\`.\n${NAMES}`,
      ),
    );
    assert.ok(
      context({ session: 'lead', sessionInEnv: false }).includes(
        '(name `captain`, roles: lead). $TEAMRIG_SESSION is not set here, so pass --session lead to every `teamrig` task and inbox command.\n',
      ),
    );
  });

  it('asks which session it is when the variable is unset, invalid or not on the team', () => {
    for (const session of [undefined, 'Not A Name '.repeat(50), 'zulu']) {
      const text = context({ session });
      assert.match(text, /: ask the user which session you are \(`teamrig who` lists them\) and pass --session <id> to every `teamrig` task and inbox command\. Message the lead as `captain`\.\n/);
      assert.doesNotMatch(text, /Not A Name|zulu/);
    }
  });

  it('names the session by its newest name, finds it by an old one, and adds the title note', () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout'), renameOf('lead', 'captain', 'chief')];
    const text = context({ renames, session: 'app-alpha', titleNote: 'Title note.' });
    assert.ok(text.endsWith(`\n\nYou are the \`alpha\` session of team \`app\` (name \`scout\`). Message the lead as \`chief\`.\n${NAMES}\nTitle note.`));
  });

  it('points a refreshed session at its handover right after who it is, before the title note', () => {
    const text = context({ refreshNote: 'Read your handover.', titleNote: 'Title note.' });
    assert.ok(text.endsWith(`Message the lead as \`captain\`.\n${NAMES}\nRead your handover.\nTitle note.`));
  });

  it('lists the live tasks right after the handover pointer, before the title note', () => {
    const live = { text: 'LIVE TASKS of alpha, read from the register at this start (1 active; the register wins):\n  T1 in-progress, p2 | Ship it', pointer: 'LIVE pointer.' };
    const text = context({ refreshNote: 'Read your handover.', liveTasksNote: live, titleNote: 'Title note.' });
    assert.ok(text.endsWith(`Message the lead as \`captain\`.\n${NAMES}\nRead your handover.\n${live.text}\nTitle note.`));
    assert.ok(context({ liveTasksNote: live }).endsWith(`${NAMES}\n${live.text}`), 'after a compaction, with no handover');
  });

  it('says the model line after the title note', () => {
    const text = context({ titleNote: 'Title note.', modelNote: 'MODEL app-alpha runs model claude-haiku-5-5.' });
    assert.ok(text.endsWith(`${NAMES}
Title note.
MODEL app-alpha runs model claude-haiku-5-5.`));
  });

  it('says the verify queue after the model line', () => {
    const text = context({ modelNote: 'MODEL line.', verifyNote: { text: 'VERIFY 1, oldest first:\n  T1 (proof: the nightly run)', pointer: 'VERIFY pointer.' } });
    assert.ok(text.endsWith(`${NAMES}
MODEL line.
VERIFY 1, oldest first:
  T1 (proof: the nightly run)`));
  });

  it('says the worktree line after the verify queue', () => {
    const text = context({ verifyNote: { text: 'VERIFY 1, oldest first:\n  T1 (proof: the nightly run)', pointer: 'VERIFY pointer.' }, worktreeNote: 'WORKTREE line.' });
    assert.ok(text.endsWith(`${NAMES}
VERIFY 1, oldest first:
  T1 (proof: the nightly run)
WORKTREE line.`));
  });

  it("appends the team's rules", () => {
    const text = context({ teamRules: [{ ancestor: undefined, path: '/kit/teams/app/rules.md', text: 'Ship small.' }] });
    assert.match(text, /# Your team's rules\nShip small\.$/);
  });

  it("lists the kept rules of a team above, tagged, before the team's own", () => {
    const config = testConfig({ names: { lead: 'captain' }, ruleConflicts: [{ file: '~/CLAUDE.md', text: 'Commit straight to main.', rule: 'worktrees', wins: 'local' }] });
    const text = context({ load: loaded({ config }), keptRulesAbove: [{ file: '~/CLAUDE.md', text: 'Push when green.', rule: 'push', wins: 'local', team: 'root' }] });
    assert.ok(
      text.includes('\nKept local rules [ruleConflicts]:\n- (team root) ~/CLAUDE.md "Push when green." wins over rule 15\n- ~/CLAUDE.md "Commit straight to main." wins over rule 16\n'),
      text,
    );
  });

  it('notes a newer config and config problems', () => {
    const text = context({
      load: loaded({ newerVersion: 3, issues: [{ path: 'lock.ttlMs', message: 'expected a number' }] }),
    });
    assert.match(text, /version 3, from a newer teamrig/);
    assert.match(text, /1 problem\(s\), each read as its default; run: teamrig config validate/);
  });

  it('says in one line why no rules load without a usable config', () => {
    assert.equal(
      context({ load: { status: 'missing', path: PATH } }),
      `teamrig is enabled here but team app has no config at ${PATH}, so no team rules are loaded. Create it with: teamrig team create app --sessions <id,id>`,
    );
    const unreadable = context({ load: { status: 'unreadable', path: PATH, issue: { path: '', message: 'not JSON' } } });
    assert.match(unreadable, /^teamrig cannot read the config of team app at \/kit\/teams\/app\/config\.json/);
  });

  it('tells the root lead it is the one the user talks to, and how it reaches its sub-teams', () => {
    const text = context({ session: 'captain', tree: { root: 'app', parentLead: undefined, children: ['ops', 'web'] } });
    assert.ok(
      text.endsWith(
        `${NAMES}\nTeam \`app\` is the root of a tree of teams: you are the one lead the user talks to, and the sub-team leads bring you their owner decisions.` +
          ' Your sub-teams (ops, web) answer to you: `teamrig list|check|plan --tree` reads their registers, and `teamrig add --team <team>` hands its lead a task.',
      ),
    );
  });

  it("sends a sub-team's lead to its parent lead, by address and name", () => {
    const parentLead = { team: 'app', id: 'lead', name: 'app-lead' };
    const text = context({ team: 'web', session: 'captain', tree: { root: 'app', parentLead, children: [] } });
    assert.ok(
      text.endsWith(
        `${NAMES}\nTeam \`web\` is a sub-team of \`app\` in the tree under \`app\`: the user talks only to the root team's lead.` +
          ' Take owner decisions and cross-team issues to your parent lead `app/lead` (name `app-lead`, inbox: `teamrig inbox add --to app/lead`), who carries them up.' +
          ' Split each task it hands you among your sessions: `teamrig add --owner <id>` gives one its part, and `teamrig open <id>` starts it.',
      ),
    );
    const withChildren = context({ team: 'web', session: 'captain', tree: { root: 'app', parentLead, children: ['ui'] } });
    assert.match(withChildren, /`teamrig open <id>` starts it\. Your sub-teams \(ui\) answer to you: /);
  });

  it('keeps every other session of a tree inside its team, known or not', () => {
    const tree = { root: 'app', parentLead: { team: 'app', id: 'lead', name: 'app-lead' }, children: ['ui'] };
    const member =
      "Team `web` is part of the tree of teams under `app`: take anything outside your team to your lead, never to another team's sessions (`teamrig inbox add` reaches every session of the tree, so keeping to your lead is up to you).";
    for (const session of ['alpha', 'zulu', undefined]) {
      assert.ok(context({ team: 'web', session, tree }).endsWith(`${NAMES}\n${member}`), String(session));
    }
  });

  it('stays inside the context cap with long team rules', () => {
    const text = context({ teamRules: [{ ancestor: undefined, path: '/kit/teams/app/rules.md', text: 'x'.repeat(CONTEXT_MAX_CHARS) }] });
    assert.ok(text.length <= CONTEXT_MAX_CHARS);
    assert.match(text, /Your team's rules are in \/kit\/teams\/app\/rules\.md/);
  });
});

describe('sessionStartContext: long notes within the context cap (T1376)', () => {
  /** A parent team's rules file the size of a real one: past the cap it was the part a session lost first. */
  const ROOT_RULES: TeamRules = { ancestor: 'root', path: '/kit/teams/root/rules.md', text: '- Root rule.\n'.repeat(179).trim() };
  const ROOT_HEADING = "\n\n# Team root's rules (a team above yours; they win over a lower team's)\n";
  const note = (head: string, length: number): CuttableNote => ({ text: `${head}${'t'.repeat(length - head.length)}`, pointer: `${head} pointer.` });
  /** The room `fitContext` leaves the long notes: the cap less the context with each at its pointer. */
  const roomBeside = (input: Partial<SessionStartInput>) => CONTEXT_MAX_CHARS - context(input).length;

  it('gives a long note as its pointer when it would push the context past the cap, and the team rules in full', () => {
    const live = note('LIVE', 8_000);
    const text = context({ refreshNote: 'Read your handover.', liveTasksNote: live, titleNote: 'Title note.', teamRules: [ROOT_RULES] });
    assert.ok(text.length <= CONTEXT_MAX_CHARS, String(text.length));
    assert.ok(text.endsWith(`\nRead your handover.\n${live.pointer}\nTitle note.${ROOT_HEADING}${ROOT_RULES.text}`), text.slice(-200));
  });

  it('shows a long note in full while the room left holds it, up to the cap exactly', () => {
    const pointer = 'LIVE pointer.';
    const room = roomBeside({ liveTasksNote: { text: pointer, pointer }, teamRules: [ROOT_RULES] });
    const exact = { text: `${pointer}${'t'.repeat(room)}`, pointer };
    const fitted = context({ liveTasksNote: exact, teamRules: [ROOT_RULES] });
    assert.equal(fitted.length, CONTEXT_MAX_CHARS);
    assert.ok(fitted.endsWith(`\n${exact.text}${ROOT_HEADING}${ROOT_RULES.text}`));
    const over = context({ liveTasksNote: { text: `${exact.text}t`, pointer }, teamRules: [ROOT_RULES] });
    assert.ok(over.endsWith(`\n${pointer}${ROOT_HEADING}${ROOT_RULES.text}`), over.slice(-200));
  });

  it('gives the room to the long notes in order, a later one still fitting the room an earlier one left', () => {
    const room = roomBeside({ liveTasksNote: { text: 'L', pointer: 'L' }, verifyNote: { text: 'V', pointer: 'V' } });
    const live = { text: `L${'l'.repeat(room - 1)}`, pointer: 'L' };
    const verify = { text: 'VV', pointer: 'V' };
    assert.ok(context({ liveTasksNote: live, verifyNote: { ...verify, text: 'VVV' } }).endsWith(`\n${live.text}\nV`), 'the verify rows no longer fit');
    const tooLong = { text: `${live.text}ll`, pointer: 'L' };
    assert.ok(context({ liveTasksNote: tooLong, verifyNote: verify }).endsWith(`\nL\nVV`), 'a long note that does not fit leaves its room to the next');
  });

  it('keeps the worst start a lead gets inside the cap: every note, a long live and verify note and a full rules file', () => {
    const own: TeamRules = { ancestor: undefined, path: '/kit/teams/app/rules.md', text: 'x'.repeat(TEAM_RULES_MAX_CHARS) };
    // The largest parent rules file a lead's worst start still shows in full, with a line on its own file after it:
    // the lead's lines come before any rules file (fitContext), so each one a lead gets takes this room. On the
    // budget, the owner decisions that hold a slice, the week split and the appeal line (T2215) cut it from 2,339
    // characters to 1,520, rule 11's hand-step sentence (T2309) to 1,247, and the security reviewer rule 1 names (a
    // team above's, `<team>/<id>`, prints longest) to 1,091; past it the file comes as its pointer.
    const parent: TeamRules = { ...ROOT_RULES, text: '- Root rule.\n'.repeat(84).trim() };
    const text = context({
      load: loaded({ config: testConfig({ names: { lead: 'captain' }, roles: { lead: 'lead', securityReviewer: `${'t'.repeat(32)}/${'r'.repeat(32)}` }, budget: { enabled: true, accountLead: 'a'.repeat(32), shareFloorPct: CONFIG_LIMITS.shareFloorPct.max } }) }),
      session: 'captain',
      refreshNote: 'Read your handover.',
      liveTasksNote: note('LIVE', 20_000),
      titleNote: 'Title note.',
      modelNote: 'MODEL line.',
      verifyNote: note('VERIFY', 20_000),
      worktreeNote: 'WORKTREE line.',
      tree: { root: 'root', parentLead: { team: 'root', id: 'lead', name: 'root-lead' }, children: ['ui'] },
      teamRules: [parent, own],
    });
    assert.ok(text.length <= CONTEXT_MAX_CHARS, String(text.length));
    assert.ok(text.includes('\nLIVE pointer.\nTitle note.\nMODEL line.\nVERIFY pointer.\nWORKTREE line.'), text.slice(-400));
    assert.ok(text.includes(`${ROOT_HEADING}${parent.text}\n\nYour team`), 'the parent team rules in full, then a line on its own file');
  });
});

describe('sessionStartOutput', () => {
  it('wraps the context as SessionStart additionalContext', () => {
    assert.deepEqual(JSON.parse(sessionStartOutput('hello')), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
    });
  });

  it('shows the notices to the user as one systemMessage, a line each', () => {
    assert.deepEqual(JSON.parse(sessionStartOutput('hello', ['MODEL lead runs model claude-opus-5-5', undefined, 'teamrig needs git'])), {
      systemMessage: 'MODEL lead runs model claude-opus-5-5\nteamrig needs git',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
    });
  });

  it('shows no systemMessage when every notice is absent', () => {
    assert.equal('systemMessage' in JSON.parse(sessionStartOutput('hello', [undefined])), false);
  });
});
