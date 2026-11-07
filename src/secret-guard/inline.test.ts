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

  it('reads a wildcard in a string as a plain name when nothing in the code expands it (T1098)', () => {
    assert.deepEqual(printed(`node -e "console.log(hook.matcher || '*')"`), []);
    assert.deepEqual(printed(`node -e "console.log(new RegExp('.*').test(line))"`), []);
    assert.deepEqual(printed(`node -e "console.log(require('fs').readFileSync('.e*', 'utf8'))"`), []);
    assert.deepEqual(printed(`python -c "print(open('.e*').read())"`), []);
    assert.deepEqual(printed(`ruby -e 'puts line.sub(".*", "")'; perl -e 'print "*"'; php -r 'echo ".*";'`), []);
    assert.deepEqual(printed(`node -e "console.log(require('path').join(require('os').homedir(), '*'))"`), []);
    assert.deepEqual(printed(`node -e 'console.log(\`rows \${n}\`, ".*")'`), []);
    assert.deepEqual(printed(`ruby -e 'puts myDir[".*"], reopen, opened'`), []);
    assert.deepEqual(printed(`perl -e 'print $reopen, $opened, $aqx, $qxb, ".*"'`), []);
  });

  it('still reads a secret file named beside such a string, or as a plain name (T1098)', () => {
    assert.deepEqual(printed(`node -e "console.log(require('fs').readFileSync('.env', 'utf8'), '*')"`), ['the content of .env']);
    assert.deepEqual(printed(`python -c "print(open('*.pem').read())"`), ['the content of *.pem']);
    assert.deepEqual(printed(`python -c "import os; print(open(os.path.join(os.path.expanduser('~'), '.npmrc')).read())"`), ['the content of .npmrc']);
  });

  it('keeps the wildcard reading where the code can expand it: a glob call or a shell (T1098)', () => {
    const expanding = [
      `node -e "console.log(require('fs').globSync('.e*'))"`,
      `node -e "console.log(require('child_process').execSync('cat ' + '.e*').toString())"`,
      `node -e "console.log(require('child_process').spawnSync('cat', ['.e*'], {shell: true}).stdout.toString())"`,
      `python -c "import glob; print(glob.glob('.e*'))"`,
      `python -c "import fnmatch, os; print(fnmatch.filter(os.listdir(), '.e*'))"`,
      `python -c "import subprocess; print(subprocess.run('cat ' + '.e*', capture_output=True))"`,
      `python -c "import os; print(os.popen('cat ' + '.e*').read())"`,
      `ruby -e 'puts Dir[".e*"]'`,
      `ruby -e 'puts Dir.glob(".e*")'`,
      `perl -e 'print glob(".e*")'`,
      `perl -e 'print qx(cat) . ".e*"'`,
      `php -r 'print_r(glob(".e*"));'`,
      `php -r 'echo passthru("cat " . ".e*");'`,
      `node -e "console.log(require('minimatch')(name, '.e*'))"`,
      `node -e "console.log(require('micromatch')(names, '.e*'))"`,
      `node -e "console.log(require('picomatch')('.e*')(name))"`,
      `php -r 'echo system("cat " . ".e*");'`,
      `node -e "console.log(require('child_process').spawnSync('cat', ['.e*']).stdout.toString())"`,
      `node -e "console.log(require('shelljs').cat('.e*').toString())"`,
      `bun -e "console.log(new Bun.Glob('.e*').scanSync())"`,
      `deno eval "console.log(new Deno.Command('cat', {args: ['.e*']}).outputSync())"`,
      `deno eval "console.log(Deno.run({cmd: ['cat', '.e*']}))"`,
      `bun -e 'const f = ".e*"; console.log(await $\`cat \${f}\`)'`,
      `python2 -c "import commands; print(commands.getoutput('cat ' + '.e*'))"`,
      `python2 -c "import commands; print(commands.getstatusoutput('cat ' + '.e*'))"`,
      `ruby -e 'f = ".e*"; puts \`cat #{f}\`'`,
      `ruby -e 'f = ".e*"; puts %x(cat #{f})'`,
      `ruby -e 'f = ".e*"; puts Open3.capture2("cat #{f}")'`,
      `ruby -e 'f = ".e*"; puts open("| cat #{f}").read'`,
      `perl -e '$f = ".e*"; print \`cat $f\`'`,
      `perl -e '$f = ".e*"; open(F, "cat $f |"); print <F>'`,
      `perl -e '$f = ".e*"; open3(undef, \\*O, undef, "cat $f"); print <O>'`,
      `php -r '$f = ".e*"; echo \`cat $f\`;'`,
      `php -r '$f = ".e*"; print_r(proc_open("cat $f", [], $p));'`,
    ];
    for (const command of expanding) {
      assert.deepEqual(printed(command), ['the content of .e*'], command);
    }
  });

  it('keeps it for a word the shell hands the code, which the shell expands (T1098)', () => {
    assert.deepEqual(printed('node -e "console.log(process.argv)" .e*'), ['the content of .e*']);
  });
});

describe('printsInline', () => {
  it('is true for inline code that prints, by a call or a print option', () => {
    const prints = (command: string): boolean[] => runs(command).map(printsInline);
    assert.deepEqual(prints('node -e "console.log(1)"; node -e "fetch(u)"; perl -pe 1; node app.js; ruby -rpp -e 1'), [true, false, true, false, false]);
  });
});
