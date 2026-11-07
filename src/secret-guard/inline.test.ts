import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import { programsOf, type ProgramRun } from '../package-guard/programs.ts';
import { describeFinding } from './findings.ts';
import { inlineFindings, printsInline } from './inline.ts';
import { secretRulesOf } from './rules.ts';

const rules = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32');

function runs(command: string): ProgramRun[] {
  return programsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect: 'bash' });
}

function printed(command: string): string[] {
  return runs(command)
    .flatMap((run) => inlineFindings(run, rules))
    .map(describeFinding);
}

describe('inlineFindings', () => {
  it('reads JS code that prints a secret variable or the whole environment', () => {
    assert.deepEqual(printed('node -e "console.log(process.env.GITHUB_TOKEN)"'), ['the value of $GITHUB_TOKEN']);
    assert.deepEqual(printed('node -e "console.log(process.env)"; node -p "process.env"; deno eval "console.log(Deno.env.toObject())"'), [
      'the whole environment',
      'the whole environment',
      'the whole environment',
    ]);
  });

  it('lets code that prints no secret, or prints nothing, pass', () => {
    assert.deepEqual(printed('node -e "console.log(Object.keys(process.env))"; node -e "console.log(process.env.HOME)"'), []);
    assert.deepEqual(printed("node -e \"fetch(u, {headers: {a: process.env.NPM_TOKEN}})\"; node app.js; ruby -rpp -e 'x = ENV[\"GH_TOKEN\"]'"), []);
  });

  it('lets printing code pass whose text holds a reversed range, which once threw (T1960)', () => {
    assert.deepEqual(printed(`node -e 'console.log("near[near.length-1]")'`), []);
    assert.deepEqual(printed("node -e 'console.log(`last ${near[near.length-1]}`)'"), []);
  });

  it('reads python, ruby, perl and php code, and the files it prints', () => {
    assert.deepEqual(printed(`python -c "import os; print(os.environ['AWS_SECRET_ACCESS_KEY'])"`), ['the value of $AWS_SECRET_ACCESS_KEY']);
    assert.deepEqual(printed(`python3 -c "print(open('.env').read())"`), ['the content of .env']);
    assert.deepEqual(printed(`python -c "import os; print(open(os.path.expanduser('~/.npmrc')).read())"`), ['the content of ~/.npmrc']);
    assert.deepEqual(printed(`ruby -e 'puts ENV["GH_TOKEN"]'; php -r 'echo getenv("DB_PASS");'`), ['the value of $GH_TOKEN', 'the value of $DB_PASS']);
    assert.deepEqual(printed("perl -ne 'print' .env; perl -pe 1 server.key"), ['the content of .env', 'the content of server.key']);
  });

  it('reads code a here-document feeds the interpreter', () => {
    assert.deepEqual(printed("python - <<'EOF'\nimport os\nprint(os.environ)\nEOF"), ['the whole environment']);
  });
});

describe('printsInline', () => {
  it('is true for inline code that prints, by a call or a print option', () => {
    const prints = (command: string): boolean[] => runs(command).map(printsInline);
    assert.deepEqual(prints('node -e "console.log(1)"; node -e "fetch(u)"; perl -pe 1; node app.js; ruby -rpp -e 1'), [true, false, true, false, false]);
  });
});
