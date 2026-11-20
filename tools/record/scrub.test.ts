import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PLACEHOLDERS, projectSlug, Scrubber, type ScrubRoots } from './scrub.ts';

const WINDOWS: ScrubRoots = { cwd: 'C:\\Temp\\rec\\cwd', temp: 'C:\\Temp', home: 'C:\\Users\\someone', user: 'someone', host: 'HOSTBOX' };
const POSIX: ScrubRoots = { cwd: '/tmp/rec/cwd', temp: '/tmp', home: '/home/someone', user: 'someone', host: 'hostbox' };

/** An address built here, so this file holds none the repository scrub would refuse. */
function address(name: string): string {
  return [name, 'mail.invalid'].join('@');
}

describe('projectSlug', () => {
  it('names a session folder as Claude Code names its transcripts folder', () => {
    assert.equal(projectSlug(WINDOWS.cwd), 'C--Temp-rec-cwd');
    assert.equal(projectSlug(POSIX.cwd), '-tmp-rec-cwd');
  });
});

describe('Scrubber.text', () => {
  it('starts a path under a root with its placeholder, however the path is spelled, and gives its rest forward slashes', () => {
    const scrubber = new Scrubber(WINDOWS);
    const spellings: readonly (readonly [string, string])[] = [
      ['C:\\Temp\\rec\\cwd\\notes.txt', '{{cwd}}/notes.txt'],
      ['C:\\\\Temp\\\\rec\\\\cwd\\\\sub\\\\notes.txt', '{{cwd}}/sub/notes.txt'],
      ['c:/temp/rec/cwd/notes.txt', '{{cwd}}/notes.txt'],
      ['/c/Temp/rec/cwd/sub/notes.txt', '{{cwd}}/sub/notes.txt'],
      ['C:\\Temp\\rec\\cwd', '{{cwd}}'],
      ['C:\\Temp\\claude\\tasks\\a1.output', '{{temp}}/claude/tasks/a1.output'],
      ['C:\\Users\\someone\\.claude\\settings.json', '{{home}}/.claude/settings.json'],
    ];
    for (const [raw, scrubbed] of spellings) {
      assert.equal(scrubber.text(raw), scrubbed);
    }
  });

  it('ends a path where its text ends, and scrubs each path of a longer text', () => {
    assert.equal(
      new Scrubber(WINDOWS).text('Read "C:\\Temp\\rec\\cwd\\notes.txt" (1 line), wrote C:\\Temp\\rec\\cwd\\a b.txt, left C:\\Temp\\rec\\cwd.'),
      'Read "{{cwd}}/notes.txt" (1 line), wrote {{cwd}}/a b.txt, left {{cwd}}.',
    );
  });

  it('takes the deepest root a path lies under, and names the project folder inside one', () => {
    const windows = new Scrubber(WINDOWS);
    assert.equal(windows.text('C:\\Users\\someone\\.claude\\projects\\C--Temp-rec-cwd\\s.jsonl'), '{{home}}/.claude/projects/{{cwd-slug}}/s.jsonl');
    const posix = new Scrubber({ ...POSIX, cwd: '/home/someone/tmp/rec', temp: '/home/someone/tmp' });
    assert.equal(posix.text('/home/someone/tmp/rec/a /home/someone/tmp/b /home/someone/c'), '{{cwd}}/a {{temp}}/b {{home}}/c');
    assert.equal(new Scrubber(POSIX).text('/home/someone/.claude/projects/-tmp-rec-cwd/s.jsonl'), '{{home}}/.claude/projects/{{cwd-slug}}/s.jsonl');
  });

  it('leaves a folder that only starts like a root, and a root named inside a longer path', () => {
    const windows = new Scrubber(WINDOWS);
    assert.equal(windows.text('C:\\Temp\\rec\\cwd-other\\x.txt'), '{{temp}}/rec/cwd-other/x.txt');
    assert.equal(windows.text('C:\\Temporary\\x.txt'), 'C:\\Temporary\\x.txt');
    const posix = new Scrubber(POSIX);
    assert.equal(posix.text('/var/tmp/x.txt and /tmp/x.txt'), '/var/tmp/x.txt and {{temp}}/x.txt');
    assert.equal(posix.text('/tmp/rec/cwd_2/x.txt'), '{{temp}}/rec/cwd_2/x.txt');
  });

  it('skips a root the machine does not have', () => {
    assert.equal(new Scrubber({ ...POSIX, temp: '', home: '' }).text('/tmp/rec/cwd/a /tmp/b /home/user/c'), '{{cwd}}/a /tmp/b /home/user/c');
  });

  it('numbers each UUID and each API id by first appearance, the same one the same way every time', () => {
    const scrubber = new Scrubber(POSIX);
    const first = '5b1f0c9e-6d2a-4e7b-9c3d-1a2b3c4d5e6f';
    const second = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    assert.equal(
      scrubber.text(`${first} ${second} ${first.toUpperCase()}`),
      '00000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000002 00000000-0000-4000-8000-000000000001',
    );
    assert.equal(scrubber.text(`session ${second}`), 'session 00000000-0000-4000-8000-000000000002');
    assert.equal(scrubber.text('toolu_01AbCdEfGh msg_01ZyXwVuTs toolu_01AbCdEfGh'), 'toolu_recorded0001 msg_recorded0002 toolu_recorded0001');
    assert.equal(scrubber.text('req_011CabcDEF srvtoolu_01QwErTy toolu_x'), 'req_recorded0003 srvtoolu_recorded0004 toolu_x');
  });

  it("replaces the user's and the machine's name as whole words, in any letter case", () => {
    const scrubber = new Scrubber(WINDOWS);
    assert.equal(scrubber.text('someone on hostbox; SOMEONE@HOSTBOX; someones hostbox2'), 'user on host; user@host; someones hostbox2');
  });

  it('leaves a name too short to be told from part of a word', () => {
    assert.equal(new Scrubber({ ...POSIX, user: 'al', host: 'pc' }).text('al on pc'), 'al on pc');
  });

  it("replaces an e-mail address whole, the user's name in it included", () => {
    const scrubber = new Scrubber(POSIX);
    assert.equal(scrubber.text(`Signed in as ${address('dana.someone')}, cc ${address('other')}.`), 'Signed in as user@example.com, cc user@example.com.');
  });
});

describe('Scrubber.value', () => {
  it('scrubs every string of a JSON value, its keys included, and leaves what is no string', () => {
    const scrubber = new Scrubber(POSIX);
    assert.deepEqual(
      scrubber.value({
        cwd: '/tmp/rec/cwd',
        '/tmp/rec/cwd/notes.txt': [1, true, null, '/tmp/rec/cwd/notes.txt', { owner: 'someone' }],
        count: 2,
      }),
      { cwd: '{{cwd}}', '{{cwd}}/notes.txt': [1, true, null, '{{cwd}}/notes.txt', { owner: 'user' }], count: 2 },
    );
  });

  it('replaces a signature by a fixed word, wherever it is, and leaves one that is no string', () => {
    const scrubber = new Scrubber(POSIX);
    assert.deepEqual(scrubber.value({ content: [{ type: 'thinking', thinking: '', signature: 'RXJhc2VkLg==' }], signature: 7 }), {
      content: [{ type: 'thinking', thinking: '', signature: 'recorded-signature' }],
      signature: 7,
    });
  });
});

describe('PLACEHOLDERS', () => {
  it('names each root a reader fills in', () => {
    assert.deepEqual(PLACEHOLDERS, { cwd: '{{cwd}}', cwdSlug: '{{cwd-slug}}', temp: '{{temp}}', home: '{{home}}' });
  });
});
