import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolUse } from '../budget/line.ts';
import { promptLine, replyLine, resultsLine, transcript } from '../testing/transcript-lines.ts';
import { leadNudgeLine, leadStopLine, leadTallyOf, leadWorkOf, OwnPaths, taskOwnersOf, tasksSearched, TeamFolders, type LeadPaths, type SubTeamPlace } from './lead-boundary.ts';
import { turnTasksOf, turnToolsOf } from './loop-nudge.ts';

const TEAM_HOME = '~/.teamrig/teams/app';
const OWN = new OwnPaths([TEAM_HOME, '~/ops/lead', '~/ops/board/lead.md', '~/.claude/projects/*/memory'], 'D:\\team\\lee');

/** A team below `app`; `ui` hangs under `web`, so both route to web's lead. */
function subTeam(team: string): SubTeamPlace {
  const home = `~/.teamrig/teams/${team}`;
  return { team, home, own: [`${home}/config.json`, `${home}/rules.md`, `${home}/state`], owner: 'web/lead' };
}

/** The register's owners of the tasks whose folders the tests search: T1 is the lead's, T2 alpha's. */
const TASK_OWNERS: ReadonlyMap<string, string> = new Map([
  ['T1', 'lead'],
  ['T2', 'alpha'],
]);

function teamFolders(taskOwners: ReadonlyMap<string, string>): TeamFolders {
  return new TeamFolders(
    {
      home: TEAM_HOME,
      own: [`${TEAM_HOME}/config.json`, `${TEAM_HOME}/rules.md`, `${TEAM_HOME}/state`],
      lead: 'lead',
      sessions: ['lead', 'alpha', 'bravo'],
      subTeams: [subTeam('web'), subTeam('ui')],
      tasks: `${TEAM_HOME}/tasks`,
      taskOwners,
    },
    'D:\\team\\lee',
  );
}

const TEAM = teamFolders(TASK_OWNERS);
const PATHS: LeadPaths = { own: OWN, team: TEAM };

function tool(name: string, input: { readonly path?: string; readonly command?: string; readonly url?: string } = {}, id = 'x'): ToolUse {
  return { id, name, command: input.command, ...(input.path === undefined ? {} : { path: input.path }), ...(input.url === undefined ? {} : { url: input.url }) };
}

const g1 = tool('Grep', {}, 'g1');
const g2 = tool('Grep', {}, 'g2');
const g3 = tool('Grep', {}, 'g3');
const g4 = tool('Grep', {}, 'g4');

describe('the lead boundary', () => {
  it('counts an edit outside the lead own files, whatever the home and slash spelling', () => {
    assert.equal(leadWorkOf(tool('Edit', { path: 'D:\\work\\app\\src\\a.ts' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Write', { path: 'D:/team/lee/ops/lead/agenda.md' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Edit', { path: 'd:\\team\\lee\\.claude\\projects\\work-app\\memory\\x.md' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Edit', { path: 'D:/team/lee/ops/leader/x.md' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat > ~/ops/lead/notes.md <<EOF' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Set-Content -Path $HOME\\ops\\board\\lead.md -Value x' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: "sed -i 's/a/b/' /d/work/app/CLAUDE.md" }), PATHS), 'edit');
  });

  it('counts a shell edit by the program that writes, not by its words in an argument', () => {
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat <<EOF > src/a.ts\nx\nEOF' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat src/a.ts > /dev/null' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: "perl -pi -e 's/a/b/' src/a.ts" }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: `node -e "require('fs').writeFileSync('a.ts', '')"` }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: `node --eval="require('fs').writeFileSync('a.ts', '')"` }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: `node -p "require('fs').readFileSync('a.ts', 'utf8')" a.ts` }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: "node - <<'EOF'\nrequire('fs').writeFileSync('a.ts', '')\nEOF" }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: "node a.js <<'EOF'\nwriteFileSync\nEOF" }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'git diff | patch -p1' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Out-File -FilePath C:\\app\\a.ts' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig add --description "use sed -i or cat > a.ts, then perl -pi"' }), PATHS), undefined);
  });

  it('counts a git step that changes a repository, also behind a wrapper, but not the words in a note', () => {
    assert.equal(leadWorkOf(tool('Bash', { command: 'cd D:/work/app && git commit -m x' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'git -C D:/work/app -c core.x=1 rebase origin/main' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig queue --session lead --what ship -- git push origin main' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'bash -c "git commit -m x"' }), PATHS), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'git log --oneline -3' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'node teamrig.js set T1 --note "after git commit"' }), PATHS), undefined);
    // T505: a register line whose description quotes a hooked commit ran no git.
    const quoted = 'teamrig add --owner bravo --priority p2 --description "refused: cd W && git commit -m \'x\' -- then git push"';
    assert.equal(leadWorkOf(tool('Bash', { command: quoted }), PATHS), undefined);
    const commit = tool('Bash', { command: 'git commit -m x' });
    assert.match(leadNudgeLine([commit], commit, PATHS, 3) ?? '', /^teamrig: the lead edited git itself\./);
  });

  it('counts tests and builds by the program run, not by its words in an argument (T483)', () => {
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm test' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm --prefix app run test:unit' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm run build' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npx tsc --noEmit -p .' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npx vitest run' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'node --disable-warning=X --test src/a.test.ts' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'node node_modules/typescript/bin/tsc -p tsconfig.json' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig list --session lead && node dist/cli/main.js show T1' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig queue --what t -- teamrig test -- npm test' }), PATHS), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm ci && npm run dev' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'node cli.js --test-mode' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig add --description "time npm ci, jest and build, then npx tsc"' }), PATHS), undefined);
  });

  it('counts code searches, but not reading results or docs', () => {
    assert.equal(leadWorkOf(tool('Read', { path: 'D:/work/app/src/a.ts' }), PATHS), 'search');
    assert.equal(leadWorkOf(tool('Read', { path: 'D:/work/app/docs/plan.md' }), PATHS), undefined);
    assert.equal(leadWorkOf(g1, PATHS), 'search');
    assert.equal(leadWorkOf(tool('Glob', { path: 'D:/team/lee/ops/lead' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -rn foo src' }), PATHS), 'search');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -n x ~/ops/board/lead.md' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'ls | grep x' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'git log --oneline | grep T505' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'git grep -n foo' }), PATHS), 'search');
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Select-String -Path src\\*.ts -Pattern x' }), PATHS), 'search');
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Get-Content a.log | Select-String x' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig add --description "it ran: grep -rn foo src"' }), PATHS), undefined);
  });

  it('nudges the lead once a turn per kind, and for searches at the threshold only', () => {
    const first = tool('Edit', { path: 'C:/app/a.ts' }, 'e1');
    const second = tool('Edit', { path: 'C:/app/b.ts' }, 'e2');
    assert.match(leadNudgeLine([first], first, PATHS, 3) ?? '', /^teamrig: the lead edited a\.ts itself\. The lead hands such work to the owning session/);
    assert.equal(leadNudgeLine([first, second], second, PATHS, 3), undefined);
    const test = tool('Bash', { command: 'npm test' }, 't1');
    assert.match(leadNudgeLine([first, test], test, PATHS, 3) ?? '', /^teamrig: the lead ran a test or a build itself\./);
    assert.equal(leadNudgeLine([g1, g2], g2, PATHS, 3), undefined);
    assert.match(leadNudgeLine([g1, g2, g3], g3, PATHS, 3) ?? '', /^teamrig: the lead made 3 code searches itself this turn\./);
    assert.equal(leadNudgeLine([g1, g2, g3, g4], g4, PATHS, 3), undefined);
    assert.equal(leadNudgeLine([g1], g1, PATHS, 0), undefined);
    const own = tool('Edit', { path: '~/ops/lead/agenda.md' }, 'o1');
    assert.equal(leadNudgeLine([own], own, PATHS, 3), undefined);
  });

  it('shows the owner what the lead did itself, naming at most three files', () => {
    const edits = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'a.ts'].map((name, index) => tool('Edit', { path: `C:/app/${name}` }, `e${index}`));
    assert.equal(
      leadStopLine(leadTallyOf([...edits, tool('Bash', { command: 'npm test' })], PATHS), 3),
      'Lead boundary: this turn the lead did 5 edits (a.ts, b.ts, c.ts +1 more), 1 test or build itself; it delegates such work [leadBoundary].',
    );
    assert.equal(leadStopLine(leadTallyOf([g1, g2], PATHS), 3), undefined);
    assert.equal(leadStopLine(leadTallyOf([g1, g2, g3], PATHS), 3), 'Lead boundary: this turn the lead did 3 code searches itself; it delegates such work [leadBoundary].');
    assert.equal(leadStopLine(leadTallyOf([g1, g2, g3], PATHS), 0), undefined);
  });

  it('counts web lookups and searches of other sessions places in the team folder as research (T736)', () => {
    assert.equal(leadWorkOf(tool('WebFetch', { url: 'https://vendor.example/terms' }), PATHS), 'research');
    assert.equal(leadWorkOf(tool('WebSearch'), PATHS), 'research');
    assert.equal(leadWorkOf(tool('Grep', { path: 'D:\\team\\lee\\.teamrig\\teams\\app\\notes\\alpha' }), PATHS), 'research');
    assert.equal(leadWorkOf(tool('Glob', { path: '~/.teamrig/teams/app' }), PATHS), 'research');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -rn vendor ~/.teamrig/teams/app/notes' }), PATHS), 'research');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -n x D:/team/lee/.teamrig/teams/app/handover/bravo.md' }), PATHS), 'research');
    assert.equal(leadWorkOf(tool('Grep', { path: '~/.teamrig/teams/app/notes/lead' }), PATHS), undefined, 'the lead own notes');
    assert.equal(leadWorkOf(tool('Grep', { path: '~/.teamrig/teams/app/state' }), PATHS), undefined, 'the register');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -n leadBoundary ~/.teamrig/teams/app/config.json' }), PATHS), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat ~/.teamrig/teams/app/notes/alpha/board.md' }), PATHS), undefined, 'a read is no search');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -rn x ~/.teamrig/teams/application' }), PATHS), 'search', 'another folder that starts alike');
  });

  it('counts a search of a sub-team folder as research for the child team lead it hangs under (T1019)', () => {
    const front = tool('Grep', { path: '~/.teamrig/teams/web/notes/front' }, 'f1');
    assert.match(leadNudgeLine([front], front, PATHS, 3, ['alpha']) ?? '', /research itself \(web\/notes\/front\)\. Send the question to web\/lead as/);
    const pixel = tool('Bash', { command: 'grep -rn x D:/team/lee/.teamrig/teams/ui/handover/pixel.md' }, 'p1');
    assert.match(leadNudgeLine([pixel], pixel, PATHS, 3) ?? '', /research itself \(ui\/handover\/pixel\.md\)\. Send the question to web\/lead as/, 'a grandchild team routes through its child team');
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/web'), { name: 'web', owner: 'web/lead' });
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/web/notes/lead'), { name: 'web/notes/lead', owner: 'web/lead' }, 'the child lead notes are no place of the parent lead');
    assert.equal(TEAM.researchOf('~/.teamrig/teams/web/state/events.jsonl'), undefined, 'its register');
    assert.equal(TEAM.researchOf('~/.teamrig/teams/ui/config.json'), undefined, 'its config');
    assert.equal(leadWorkOf(tool('Grep', { path: '~/.teamrig/teams/other/notes' }), PATHS), 'search', 'a team outside the tree');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -rn x ~/.teamrig/teams/webapp' }), PATHS), 'search', 'another folder that starts alike');
  });

  it('reads a sub-team folder nested in the lead own folder as the sub-team, and the lead own folder nested in it as its own', () => {
    const nested = (home: string, sub: string): TeamFolders =>
      new TeamFolders(
        { home, own: [`${home}/state`], lead: 'lead', sessions: ['lead', 'alpha'], subTeams: [{ team: 'web', home: sub, own: [`${sub}/state`], owner: 'web/lead' }], tasks: `${home}/tasks`, taskOwners: new Map() },
        'D:\\team\\lee',
      );
    assert.deepEqual(nested('~/teams/app', '~/teams/app/web').researchOf('~/teams/app/web/notes'), { name: 'web/notes', owner: 'web/lead' });
    assert.deepEqual(nested('~/teams/web/app', '~/teams/web').researchOf('~/teams/web/app/notes/alpha'), { name: 'notes/alpha', owner: 'alpha' });
    assert.equal(nested('~/teams/web/app', '~/teams/web').researchOf('~/teams/web/app/state'), undefined);
  });

  it("reads the lead's own task's folder as its place and another session's as that session's research (T1467)", () => {
    assert.equal(leadWorkOf(tool('Grep', { path: '~/.teamrig/teams/app/tasks/T1' }), PATHS), undefined, 'the lead own task');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -rn x D:/team/lee/.teamrig/teams/app/tasks/T1/design.md' }), PATHS), undefined);
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/app/tasks/T2/notes.md'), { name: 'tasks/t2', owner: 'alpha', task: 'T2' });
    const alpha = tool('Glob', { path: 'D:\\team\\lee\\.teamrig\\teams\\app\\tasks\\T2' }, 'a1');
    assert.match(leadNudgeLine([alpha], alpha, PATHS, 3, ['bravo']) ?? '', /research itself \(tasks\/t2\)\. Send the question to alpha as/);
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/app/tasks/T9'), { name: 'tasks/t9', owner: undefined, task: 'T9' }, 'a task the register does not hold');
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/app/tasks'), { name: 'tasks', owner: undefined }, 'every task folder');
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/app/tasks/old/T1'), { name: 'tasks/old', owner: undefined }, 'no task id');
    assert.deepEqual(TEAM.researchOf('~/.teamrig/teams/app/tasks/T01'), { name: 'tasks/t01', owner: undefined }, 'no register id');
  });

  it('names the tasks whose folders a turn searches, each once, before their owners are known (T1467)', () => {
    const turn = [
      tool('Grep', { path: '~/.teamrig/teams/app/tasks/T1' }, 'k1'),
      tool('Bash', { command: 'grep -rn x ~/.teamrig/teams/app/tasks/T2/a.md' }, 'k2'),
      tool('Grep', { path: '~/.teamrig/teams/app/tasks/T1/b.md' }, 'k3'),
      tool('Grep', { path: '~/.teamrig/teams/app/notes/alpha' }, 'k4'),
      tool('Read', { path: '~/.teamrig/teams/app/tasks/T3/c.md' }, 'k5'),
    ];
    const unknown: LeadPaths = { own: OWN, team: teamFolders(new Map()) };
    assert.deepEqual(tasksSearched(turn, unknown), ['T1', 'T2'], 'a read is no search');
    assert.deepEqual(tasksSearched(turn, PATHS), ['T2'], "the lead's own task's folder is no research once its owner is known");
    assert.equal(leadTallyOf(turn, PATHS).research, 2);
  });

  it('asks the lead once a turn to send research to the session that owns it', () => {
    const fetch = tool('WebFetch', { url: 'https://vendor.example/terms' }, 'w1');
    const again = tool('WebFetch', { url: 'https://other.example/' }, 'w2');
    assert.equal(
      leadNudgeLine([fetch], fetch, PATHS, 3, ['alpha']),
      'teamrig: the lead did research itself (vendor.example). Send the question to alpha as a register task with a deadline and relay its answer [leadBoundary].',
    );
    assert.equal(leadNudgeLine([fetch, again], again, PATHS, 3, ['alpha']), undefined);
    assert.match(leadNudgeLine([fetch], fetch, PATHS, 3) ?? '', /Send the question to the session that owns it as a register task/);
    assert.match(leadNudgeLine([fetch], fetch, PATHS, 3, ['alpha', 'bravo']) ?? '', /Send the question to alpha or bravo as/);
    const notes = tool('Grep', { path: '~/.teamrig/teams/app/notes/bravo/board.md' }, 'n1');
    assert.match(leadNudgeLine([notes], notes, PATHS, 3, ['alpha']) ?? '', /research itself \(notes\/bravo\)\. Send the question to bravo as/);
    const page = tool('WebFetch', { url: 'not a url' }, 'w3');
    assert.match(leadNudgeLine([page], page, PATHS, 3) ?? '', /research itself \(a web page\)/);
  });

  it('lists the research on the owner turn-end line, after tests and before searches', () => {
    const turn = [
      tool('WebFetch', { url: 'https://vendor.example/a' }, 'w1'),
      tool('WebFetch', { url: 'https://vendor.example/b' }, 'w2'),
      tool('WebSearch', {}, 's1'),
      tool('Grep', { path: '~/.teamrig/teams/app/notes' }, 'n1'),
      tool('Bash', { command: 'npm test' }, 't1'),
    ];
    assert.equal(
      leadStopLine(leadTallyOf(turn, PATHS), 3),
      'Lead boundary: this turn the lead did 1 test or build, 4 research lookups (vendor.example, a web search, notes) itself; it delegates such work [leadBoundary].',
    );
  });

  it('names the sessions that own the tasks a prompt names, never the lead, at most three', () => {
    const tasks = new Map<string, { readonly owner: string }>([
      ['T1', { owner: 'alpha' }],
      ['T2', { owner: 'lead' }],
      ['T3', { owner: 'alpha' }],
      ['T4', { owner: 'bravo' }],
      ['T5', { owner: 'carol' }],
      ['T6', { owner: 'dave' }],
    ]);
    assert.deepEqual(taskOwnersOf(['T2', 'T1', 'T9', 'T3', 'T4'], tasks, 'lead'), ['alpha', 'bravo']);
    assert.deepEqual(taskOwnersOf(['T1', 'T4', 'T5', 'T6'], tasks, 'lead'), ['alpha', 'bravo', 'carol']);
    assert.deepEqual(taskOwnersOf([], tasks, 'lead'), []);
  });

  it('reads the task ids the turn prompt names, each once, from the latest prompt', () => {
    const at = '2030-01-08T10:00:00.000Z';
    const reply = replyLine({ id: 'm1', requestId: 'r1', at, usage: { cacheRead: 1 }, tools: [{ id: 't1', name: 'Read', path: 'C:/app/a.ts' }] });
    const text = transcript([promptLine(at, 'see T9'), reply, promptLine(at, 'T12 asks: does T7 hold? T12 again, not T0 or XT5'), reply]);
    assert.deepEqual(turnTasksOf(text, false), ['T12', 'T7']);
    assert.deepEqual(turnTasksOf(transcript([promptLine(at), reply]), false), []);
  });

  it('reads the turn calls with their paths from the transcript, adding the current call', () => {
    const at = '2030-01-08T10:00:00.000Z';
    const text = transcript([
      promptLine(at),
      replyLine({ id: 'm1', requestId: 'r1', at, usage: { cacheRead: 1 }, tools: [{ id: 't1', name: 'Edit', path: 'C:/app/a.ts' }] }),
      resultsLine(at, [{ id: 't1', text: 'ok' }]),
    ]);
    const turn = turnToolsOf(text, false, tool('Read', { path: 'C:/app/b.ts' }, 't2'));
    assert.deepEqual(
      turn.map((call) => [call.name, call.path]),
      [
        ['Edit', 'C:/app/a.ts'],
        ['Read', 'C:/app/b.ts'],
      ],
    );
  });
});
