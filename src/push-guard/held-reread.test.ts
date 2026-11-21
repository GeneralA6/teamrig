import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editsInPlace, isAssignmentWord, LineCommands, rereadingCommands, writesFile } from './held-reread.ts';
import { launch } from './launchers.ts';
import { parseShell } from './tokenizer.ts';

/** For each command of a bash line, its first word and whether bash may read its words' held text again. */
function rereads(line: string): string[] {
  const { commands } = parseShell(line, 'bash');
  const defined = new LineCommands();
  defined.note(commands);
  const answers = rereadingCommands(commands, defined);
  return commands.map((command, index) => `${command.words[0]?.text ?? ''}:${answers[index] === true ? 'y' : 'n'}`);
}

/** Whether the last command of a bash line, a program, edits its files in place. */
function inPlace(line: string): boolean {
  const command = parseShell(line, 'bash').commands.at(-1);
  assert.ok(command !== undefined, line);
  const launched = launch(command.words, 'bash');
  assert.equal(launched.kind, 'program', line);
  return launched.kind === 'program' && editsInPlace(launched);
}

describe('rereadingCommands', () => {
  it('counts a builtin, a reserved word, a defined name or a dynamic head, never a plain external program', () => {
    assert.deepEqual(rereads("perl -pe 's/x/y/' f; /bin/read x; read x; command perl x; $P x"), ['perl:n', '/bin/read:n', 'read:y', 'command:n', '$P:y']);
    assert.deepEqual(rereads('for a in b; do perl x; done'), ['for:y', 'do:n', 'done:y']);
    assert.deepEqual(rereads('perl() { :; }; perl x'), ['perl:y', '{:y', '}:y', 'perl:y']);
    assert.deepEqual(rereads('function sed { :; }\nsed x'), ['function:y', '}:y', 'sed:y']);
    assert.deepEqual(rereads('enable -f ./lib.so perl\nperl x; sed x'), ['enable:y', 'perl:y', 'sed:n']);
    assert.deepEqual(rereads('alias $N=eval\nperl x'), ['alias:y', 'perl:y']);
  });

  it('counts every name after a line sources a file or evals a word known only when it runs', () => {
    assert.deepEqual(rereads('. ./lib.sh; perl x'), ['.:y', 'perl:y']);
    assert.deepEqual(rereads('source lib.sh\nperl x'), ['source:y', 'perl:y']);
    assert.deepEqual(rereads('command source lib.sh; perl x'), ['command:y', 'perl:y']);
    assert.deepEqual(rereads('eval "$DEFS"; perl x'), ['eval:y', 'perl:y']);
    assert.deepEqual(rereads('eval true; find . -name x; perl x'), ['eval:y', 'find:n', 'perl:n']);
  });

  it('counts the words of a substitution and of an arithmetic command', () => {
    assert.deepEqual(rereads('x=$(perl x)'), ['perl:y', 'x=$(perl x):y']);
    assert.deepEqual(rereads('true; (( a ))'), ['true:y', 'a:y']);
    assert.deepEqual(rereads('(( a )); perl x'), ['a:y', 'perl:n']);
    assert.deepEqual(rereads('for (( a; b; c )); do perl x; done'), ['for:y', 'a:y', 'b:y', 'c:y', 'do:n', 'done:y']);
  });

  it('counts text written for a later line, and the whole line when a group, a function or exec writes it', () => {
    assert.deepEqual(rereads('perl x > f; perl x > /dev/null 2>&1; perl x 1<> g'), ['perl:y', 'perl:n', 'perl:y']);
    assert.deepEqual(rereads('perl x | perl y | tee f; perl x | head'), ['perl:y', 'perl:y', 'tee:y', 'perl:n', 'head:n']);
    assert.deepEqual(rereads('perl x | while read l; do :; done'), ['perl:y', 'while:y', 'do:y', 'done:y']);
    assert.deepEqual(rereads('perl x | bash'), ['perl:n', 'bash:y']);
    assert.deepEqual(rereads('perl x | sort $(perl y) | dd of=f'), ['perl:y', 'perl:y', 'sort:y', 'dd:y']);
    assert.deepEqual(rereads('perl x || sort > f'), ['perl:n', 'sort:y']);
    assert.deepEqual(rereads('perl x | head; sort > f'), ['perl:n', 'head:n', 'sort:y']);
    assert.deepEqual(rereads('perl x | for a in b; do read l; done'), ['perl:y', 'for:y', 'do:y', 'done:y']);
    assert.deepEqual(rereads('(perl x; perl y) | tee f'), ['perl:y', 'perl:y', 'tee:y']);
    assert.deepEqual(rereads('f() { perl x; }; f > out'), ['f:y', '{:y', '}:y', 'f:y']);
    assert.deepEqual(rereads('perl x; exec 2> log'), ['perl:y', 'exec:y']);
    assert.deepEqual(rereads('perl x; exec 2> /dev/null'), ['perl:n', 'exec:y']);
  });
});

describe('writesFile', () => {
  it('counts every output redirection but a literal /dev/null or a copy onto the terminal streams', () => {
    const writes = (line: string): boolean[] => parseShell(line, 'bash').commands.at(-1)?.redirections.map(writesFile) ?? [];
    assert.deepEqual(writes('x > f >> g &> h >| i 2> j 1<> k > >(bash)'), [true, true, true, true, true, true, true]);
    assert.deepEqual(writes('x >&3 1>&4 > "$F" > /dev/null 2>/dev/null >&2 2>&1 >&- < f <<< w'), [true, true, true, false, false, false, false, false, false, false]);
  });
});

describe('editsInPlace', () => {
  it('reads -i in sed, perl and ruby option clusters, gawk -i inplace, and a word only known when it runs', () => {
    // Every word counts, a script's own arguments too: the safe side for a guard.
    for (const line of ['sed -i s/a/b/ f', 'sed -Ei.bak s/a/b/ f', 'sed --in-place=.b s/a/b/ f', 'gsed -n -i p f', 'perl -pi -e 1 f', 'perl -0pi.bak -e 1 f', 'perl -pie 1 f', 'ruby -i -pe 1 f', 'gawk -i inplace 1 f', 'awk --include=inplace 1 f', 'sed $OPTS s/a/b/ f', 'perl -e 1 -- -i', 'sed --i s/a/b/ f', 'sed --in-pl=.b s/a/b/ f', 'gawk --incl=inplace 1 f', 'gawk -i inplace.awk 1 f', 'gawk -iinplace 1 f', 'gawk -i /usr/share/awk/inplace.awk 1 f', 'gawk $OPTS 1 f', "sed -I '' s/a/b/ f", 'sed -nI p f', 'perl -di -pe 1 f', 'ruby -di -pe 1 f']) {
      assert.equal(inPlace(line), true, line);
    }
    for (const line of ['sed -e s/i/j/ f', 'sed -n s/a/b/p f', 'sed -fi.sed f', 'perl -ple 1 f', 'perl -Mstrict -e 1', 'ruby -e 1', 'awk 1 f', 'grep -i x f', 'sed "s/$a/b/" f', 'sed --debug s/a/b/ f', 'sed -- -x f', 'gawk -i ord 1 f', 'gawk --incl=ord 1 f']) {
      assert.equal(inPlace(line), false, line);
    }
  });
});

describe('isAssignmentWord', () => {
  it('reads plain, appending and subscripted assignments', () => {
    assert.deepEqual(['A=1', 'a_1+=x', 'a[$(x)]=1', 'a[1]+=2', '1A=x', 'a-b=1', 's/a=b/', '=x'].map(isAssignmentWord), [true, true, true, true, false, false, false, false]);
  });
});
