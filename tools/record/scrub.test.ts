import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Scrubber, type ScrubRoots } from './scrub.ts';

const WINDOWS: ScrubRoots = { cwd: 'C:\\Temp\\rec\\cwd', temp: 'C:\\Temp', home: 'C:\\Users\\someone', user: 'someone', host: 'HOSTBOX' };
const POSIX: ScrubRoots = { cwd: '/tmp/rec/cwd', temp: '/tmp', home: '/home/someone', user: 'someone', host: 'hostbox' };

/** An address built here, so this file holds none the repository scrub would refuse. */
function address(name: string): string {
  return [name, 'mail.invalid'].join('@');
}

describe('Scrubber.text', () => {
  it("names the machine's folders and the project folder before anything else, so a name inside a path goes with the path", () => {
    assert.equal(
      new Scrubber(WINDOWS).text('C:\\Temp\\rec\\cwd\\notes.txt in C:\\Users\\someone\\.claude\\projects\\C--Temp-rec-cwd, kept by someone'),
      '{{cwd}}/notes.txt in {{home}}/.claude/projects/{{cwd-slug}}, kept by user',
    );
    assert.equal(new Scrubber(POSIX).text('/home/someone/notes of someone in /tmp/a'), '{{home}}/notes of user in {{temp}}/a');
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
