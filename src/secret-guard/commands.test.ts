import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf, type ProgramRun } from '../package-guard/programs.ts';
import { commandFindings, DEFAULT_SECRET_COMMANDS } from './commands.ts';
import { PatternList } from './pattern-list.ts';

const DEFAULTS = new PatternList(DEFAULT_SECRET_COMMANDS);

function runOf(line: string): ProgramRun {
  const [run] = runsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect: 'bash' }).programs;
  assert.ok(run !== undefined, line);
  return run;
}

function dumps(line: string, commands = DEFAULTS): boolean {
  return commandFindings(runOf(line), commands).length > 0;
}

describe('commandFindings', () => {
  it('finds kubectl config view --raw, whatever order its words and options come in', () => {
    for (const line of ['kubectl config view --raw', 'kubectl --raw config view', 'KUBECTL --context prod config view --minify --raw=true']) {
      assert.equal(dumps(line), true, line);
    }
    assert.deepEqual(commandFindings(runOf('kubectl config view --raw'), DEFAULTS), [{ kind: 'command', program: 'kubectl' }]);
  });

  it('lets a view that redacts the credentials pass, and kubectl lookalikes', () => {
    for (const line of ['kubectl config view', 'kubectl config view --raw=false', 'kubectl config view --rawish', 'kubectl config get-contexts --raw', 'kubectlx config view --raw']) {
      assert.equal(dumps(line), false, line);
    }
  });

  it("lets a team add a dump command and keep one with a later !pattern", () => {
    const team = new PatternList([...DEFAULT_SECRET_COMMANDS, '^vault\\s+read\\s', '!--minify']);
    assert.equal(dumps('vault read secret/app', team), true);
    assert.equal(dumps('kubectl config view --minify --raw', team), false);
  });
});
