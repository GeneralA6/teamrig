import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolUse } from '../budget/line.ts';
import { promptLine, replyLine, resultsLine, transcript } from '../testing/transcript-lines.ts';
import { leadNudgeLine, leadStopLine, leadTallyOf, leadWorkOf, OwnPaths } from './lead-boundary.ts';
import { turnToolsOf } from './loop-nudge.ts';

const OWN = new OwnPaths(['~/ops/lead', '~/ops/board/lead.md', '~/.claude/projects/*/memory'], 'D:\\team\\lee');

function tool(name: string, input: { readonly path?: string; readonly command?: string } = {}, id = 'x'): ToolUse {
  return { id, name, command: input.command, ...(input.path === undefined ? {} : { path: input.path }) };
}

const g1 = tool('Grep', {}, 'g1');
const g2 = tool('Grep', {}, 'g2');
const g3 = tool('Grep', {}, 'g3');
const g4 = tool('Grep', {}, 'g4');

describe('the lead boundary', () => {
  it('counts an edit outside the lead own files, whatever the home and slash spelling', () => {
    assert.equal(leadWorkOf(tool('Edit', { path: 'D:\\work\\app\\src\\a.ts' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Write', { path: 'D:/team/lee/ops/lead/agenda.md' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Edit', { path: 'd:\\team\\lee\\.claude\\projects\\work-app\\memory\\x.md' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Edit', { path: 'D:/team/lee/ops/leader/x.md' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat > ~/ops/lead/notes.md <<EOF' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Set-Content -Path $HOME\\ops\\board\\lead.md -Value x' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: "sed -i 's/a/b/' /d/work/app/CLAUDE.md" }), OWN), 'edit');
  });

  it('counts a shell edit by the program that writes, not by its words in an argument', () => {
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat <<EOF > src/a.ts\nx\nEOF' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'cat src/a.ts > /dev/null' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: "perl -pi -e 's/a/b/' src/a.ts" }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: `node -e "require('fs').writeFileSync('a.ts', '')"` }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: `node --eval="require('fs').writeFileSync('a.ts', '')"` }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: `node -p "require('fs').readFileSync('a.ts', 'utf8')" a.ts` }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: "node - <<'EOF'\nrequire('fs').writeFileSync('a.ts', '')\nEOF" }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: "node a.js <<'EOF'\nwriteFileSync\nEOF" }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'git diff | patch -p1' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Out-File -FilePath C:\\app\\a.ts' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig add --description "use sed -i or cat > a.ts, then perl -pi"' }), OWN), undefined);
  });

  it('counts a git step that changes a repository, also behind a wrapper, but not the words in a note', () => {
    assert.equal(leadWorkOf(tool('Bash', { command: 'cd D:/work/app && git commit -m x' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'git -C D:/work/app -c core.x=1 rebase origin/main' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig heavy --session lead --what ship -- git push origin main' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'bash -c "git commit -m x"' }), OWN), 'edit');
    assert.equal(leadWorkOf(tool('Bash', { command: 'git log --oneline -3' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'node teamrig.js set T1 --note "after git commit"' }), OWN), undefined);
    // T505: a register line whose description quotes a hooked commit ran no git.
    const quoted = 'teamrig add --owner bravo --priority p2 --description "refused: cd W && git commit -m \'x\' -- then git push"';
    assert.equal(leadWorkOf(tool('Bash', { command: quoted }), OWN), undefined);
    const commit = tool('Bash', { command: 'git commit -m x' });
    assert.match(leadNudgeLine([commit], commit, OWN, 3) ?? '', /^teamrig: the lead edited git itself\./);
  });

  it('counts tests and builds by the program run, not by its words in an argument (T483)', () => {
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm test' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm --prefix app run test:unit' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm run build' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npx tsc --noEmit -p .' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npx vitest run' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'node --disable-warning=X --test src/a.test.ts' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'node node_modules/typescript/bin/tsc -p tsconfig.json' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig list --session lead && node dist/cli/main.js show T1' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig heavy --what t -- teamrig test -- npm test' }), OWN), 'check');
    assert.equal(leadWorkOf(tool('Bash', { command: 'npm ci && npm run dev' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'node cli.js --test-mode' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig add --description "time npm ci, jest and build, then npx tsc"' }), OWN), undefined);
  });

  it('counts code searches, but not reading results or docs', () => {
    assert.equal(leadWorkOf(tool('Read', { path: 'D:/work/app/src/a.ts' }), OWN), 'search');
    assert.equal(leadWorkOf(tool('Read', { path: 'D:/work/app/docs/plan.md' }), OWN), undefined);
    assert.equal(leadWorkOf(g1, OWN), 'search');
    assert.equal(leadWorkOf(tool('Glob', { path: 'D:/team/lee/ops/lead' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -rn foo src' }), OWN), 'search');
    assert.equal(leadWorkOf(tool('Bash', { command: 'grep -n x ~/ops/board/lead.md' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'ls | grep x' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'git log --oneline | grep T505' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'git grep -n foo' }), OWN), 'search');
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Select-String -Path src\\*.ts -Pattern x' }), OWN), 'search');
    assert.equal(leadWorkOf(tool('PowerShell', { command: 'Get-Content a.log | Select-String x' }), OWN), undefined);
    assert.equal(leadWorkOf(tool('Bash', { command: 'teamrig add --description "it ran: grep -rn foo src"' }), OWN), undefined);
  });

  it('nudges the lead once a turn per kind, and for searches at the threshold only', () => {
    const first = tool('Edit', { path: 'C:/app/a.ts' }, 'e1');
    const second = tool('Edit', { path: 'C:/app/b.ts' }, 'e2');
    assert.match(leadNudgeLine([first], first, OWN, 3) ?? '', /^teamrig: the lead edited a\.ts itself\. The lead hands such work to the owning session/);
    assert.equal(leadNudgeLine([first, second], second, OWN, 3), undefined);
    const test = tool('Bash', { command: 'npm test' }, 't1');
    assert.match(leadNudgeLine([first, test], test, OWN, 3) ?? '', /^teamrig: the lead ran a test or a build itself\./);
    assert.equal(leadNudgeLine([g1, g2], g2, OWN, 3), undefined);
    assert.match(leadNudgeLine([g1, g2, g3], g3, OWN, 3) ?? '', /^teamrig: the lead made 3 code searches itself this turn\./);
    assert.equal(leadNudgeLine([g1, g2, g3, g4], g4, OWN, 3), undefined);
    assert.equal(leadNudgeLine([g1], g1, OWN, 0), undefined);
    const own = tool('Edit', { path: '~/ops/lead/agenda.md' }, 'o1');
    assert.equal(leadNudgeLine([own], own, OWN, 3), undefined);
  });

  it('shows the owner what the lead did itself, naming at most three files', () => {
    const edits = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'a.ts'].map((name, index) => tool('Edit', { path: `C:/app/${name}` }, `e${index}`));
    assert.equal(
      leadStopLine(leadTallyOf([...edits, tool('Bash', { command: 'npm test' })], OWN), 3),
      'Lead boundary: this turn the lead did 5 edits (a.ts, b.ts, c.ts +1 more), 1 test or build itself; it delegates such work [leadBoundary].',
    );
    assert.equal(leadStopLine(leadTallyOf([g1, g2], OWN), 3), undefined);
    assert.equal(leadStopLine(leadTallyOf([g1, g2, g3], OWN), 3), 'Lead boundary: this turn the lead did 3 code searches itself; it delegates such work [leadBoundary].');
    assert.equal(leadStopLine(leadTallyOf([g1, g2, g3], OWN), 0), undefined);
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
