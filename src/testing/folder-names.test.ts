import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FolderNames, literalPattern, PLACEHOLDERS, projectSlug, withStrings, type RecordedFolders } from './folder-names.ts';

const WINDOWS: RecordedFolders = { cwd: 'C:\\Temp\\rec\\cwd', temp: 'C:\\Temp', home: 'C:\\Users\\someone' };
const POSIX: RecordedFolders = { cwd: '/tmp/rec/cwd', temp: '/tmp', home: '/home/someone' };

describe('PLACEHOLDERS', () => {
  it('names each folder a reader fills in', () => {
    assert.deepEqual(PLACEHOLDERS, { cwd: '{{cwd}}', cwdSlug: '{{cwd-slug}}', temp: '{{temp}}', home: '{{home}}' });
  });
});

describe('literalPattern', () => {
  it('matches a text with pattern characters as itself only', () => {
    const pattern = new RegExp(`^${literalPattern('a.b*(c)[d]\\e')}$`);
    assert.ok(pattern.test('a.b*(c)[d]\\e'));
    assert.ok(!pattern.test('aXb*(c)[d]\\e'));
  });
});

describe('projectSlug', () => {
  it('names a session folder as Claude Code names its transcripts folder', () => {
    assert.equal(projectSlug(WINDOWS.cwd), 'C--Temp-rec-cwd');
    assert.equal(projectSlug(POSIX.cwd), '-tmp-rec-cwd');
  });
});

describe('withStrings', () => {
  it('changes every string of a JSON value, keys included, and keeps what is no string', () => {
    const upper = (text: string): string => text.toUpperCase();
    assert.deepEqual(withStrings({ a: 'x', list: ['y', 1, null, { deep: 'z' }], flag: true, none: null }, upper), {
      A: 'X',
      LIST: ['Y', 1, null, { DEEP: 'Z' }],
      FLAG: true,
      NONE: null,
    });
    assert.equal(withStrings('x', upper), 'X');
    assert.equal(withStrings(7, upper), 7);
  });

  it('names a path that an escaped line break follows without taking the escape for its last segment', () => {
    const names = new FolderNames(WINDOWS);
    const value = { text: 'C:\\Temp\\rec\\cwd\\notes.txt\nnext' };
    const named = { text: '{{cwd}}/notes.txt\nnext' };
    assert.deepEqual(
      withStrings(value, (text) => names.named(text)),
      named,
    );
    assert.equal(names.named(JSON.stringify(value)), '{"text":"{{cwd}}/notes.txt/nnext"}');
  });
});

describe('FolderNames.named', () => {
  it('starts a path under a folder with its placeholder, however the path is spelled, and gives its rest forward slashes', () => {
    const names = new FolderNames(WINDOWS);
    const spellings: readonly (readonly [string, string])[] = [
      ['C:\\Temp\\rec\\cwd\\notes.txt', '{{cwd}}/notes.txt'],
      ['C:\\\\Temp\\\\rec\\\\cwd\\\\sub\\\\notes.txt', '{{cwd}}/sub/notes.txt'],
      ['c:/temp/rec/cwd/notes.txt', '{{cwd}}/notes.txt'],
      ['/c/Temp/rec/cwd/sub/notes.txt', '{{cwd}}/sub/notes.txt'],
      ['C:\\Temp\\rec\\cwd', '{{cwd}}'],
      ['C:\\Temp\\claude\\tasks\\a1.output', '{{temp}}/claude/tasks/a1.output'],
      ['C:\\Users\\someone\\.claude\\settings.json', '{{home}}/.claude/settings.json'],
    ];
    for (const [raw, named] of spellings) {
      assert.equal(names.named(raw), named);
    }
  });

  it('ends a path where its text ends, and names each path of a longer text', () => {
    assert.equal(
      new FolderNames(WINDOWS).named('Read "C:\\Temp\\rec\\cwd\\notes.txt" (1 line), wrote C:\\Temp\\rec\\cwd\\a b.txt, left C:\\Temp\\rec\\cwd.'),
      'Read "{{cwd}}/notes.txt" (1 line), wrote {{cwd}}/a b.txt, left {{cwd}}.',
    );
  });

  it('takes the deepest folder a path lies under, and names the project folder inside one', () => {
    const windows = new FolderNames(WINDOWS);
    assert.equal(windows.named('C:\\Users\\someone\\.claude\\projects\\C--Temp-rec-cwd\\s.jsonl'), '{{home}}/.claude/projects/{{cwd-slug}}/s.jsonl');
    const posix = new FolderNames({ cwd: '/home/someone/tmp/rec', temp: '/home/someone/tmp', home: '/home/someone' });
    assert.equal(posix.named('/home/someone/tmp/rec/a /home/someone/tmp/b /home/someone/c'), '{{cwd}}/a {{temp}}/b {{home}}/c');
    assert.equal(new FolderNames(POSIX).named('/home/someone/.claude/projects/-tmp-rec-cwd/s.jsonl'), '{{home}}/.claude/projects/{{cwd-slug}}/s.jsonl');
  });

  it('leaves a folder that only starts like one of its own, and one of its own named inside a longer path', () => {
    const windows = new FolderNames(WINDOWS);
    assert.equal(windows.named('C:\\Temp\\rec\\cwd-other\\x.txt'), '{{temp}}/rec/cwd-other/x.txt');
    assert.equal(windows.named('C:\\Temporary\\x.txt'), 'C:\\Temporary\\x.txt');
    const posix = new FolderNames(POSIX);
    assert.equal(posix.named('/var/tmp/x.txt and /tmp/x.txt'), '/var/tmp/x.txt and {{temp}}/x.txt');
    assert.equal(posix.named('/tmp/rec/cwd_2/x.txt'), '{{temp}}/rec/cwd_2/x.txt');
  });

  it('skips a folder the machine does not have, the project folder with the session folder', () => {
    assert.equal(new FolderNames({ ...POSIX, temp: '', home: '' }).named('/tmp/rec/cwd/a /tmp/b /home/user/c'), '{{cwd}}/a /tmp/b /home/user/c');
    assert.equal(new FolderNames({ ...POSIX, cwd: '' }).named('/tmp/rec/cwd/a in -tmp-rec-cwd'), '{{temp}}/rec/cwd/a in -tmp-rec-cwd');
  });

  it('names each other folder by the placeholder it is given under, one with no drive and a single segment too', () => {
    const names = new FolderNames(POSIX, { '{{kit}}': '\\kit', '{{app}}': 'D:\\work\\app' });
    assert.equal(names.named('wrote \\kit\\teams\\app\\state\\a.json and /kit/b'), 'wrote {{kit}}/teams/app/state/a.json and {{kit}}/b');
    assert.equal(names.named('d:/work/app/x and /work/kit/x and /kitchen'), '{{app}}/x and /work/kit/x and /kitchen');
  });
});

describe('FolderNames.filled', () => {
  it('puts each folder where its placeholder is, the project folder by its name, and keeps the rest of a path', () => {
    const names = new FolderNames(WINDOWS, { '{{kit}}': '/kit' });
    assert.equal(
      names.filled('{{cwd}}/notes.txt {{temp}}/a {{home}}/.claude/projects/{{cwd-slug}}/s.jsonl {{kit}}/b {{other}}'),
      'C:\\Temp\\rec\\cwd/notes.txt C:\\Temp/a C:\\Users\\someone/.claude/projects/C--Temp-rec-cwd/s.jsonl /kit/b {{other}}',
    );
  });

  it('fills a folder whose name holds a replacement pattern as it is written', () => {
    assert.equal(new FolderNames({ ...POSIX, cwd: '/tmp/$&/$1' }).filled('{{cwd}}/a'), '/tmp/$&/$1/a');
  });

  it('gives back the folders a text was named from, each path with forward slashes', () => {
    const names = new FolderNames(POSIX);
    const text = 'Read /tmp/rec/cwd/notes.txt, kept /home/someone/.claude/projects/-tmp-rec-cwd/s.jsonl';
    assert.equal(names.filled(names.named(text)), text);
  });

  it('leaves the placeholder of a folder the machine does not have', () => {
    assert.equal(new FolderNames({ cwd: '', temp: '', home: '/home/someone' }).filled('{{cwd}} {{cwd-slug}} {{temp}} {{home}}'), '{{cwd}} {{cwd-slug}} {{temp}} /home/someone');
  });
});
