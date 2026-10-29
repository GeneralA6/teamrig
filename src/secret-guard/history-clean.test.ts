import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { cleanHistory, historyPlaces } from './history-clean.ts';
import { PromptSecrets } from './prompt-secrets.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source for the scrub to flag. */
const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const OTHER_TOKEN = join('gh', 'p_', 'b2'.repeat(18));
const PASSWORD = join('s3', 'cret', 'Value9');

const places = historyPlaces('/u/.claude');
const secrets = new PromptSecrets();
/** The hashes a blocked prompt left: the token and the URL password. */
const wanted = new Set(secrets.secretsIn(join(TOKEN, ' https://app:', PASSWORD, '@db')).map(({ hash }) => hash));

/** One history line as Claude Code writes it. */
function entry(display: string, pastedContents: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ display, pastedContents, timestamp: 1, project: '/work/app', sessionId: 's1' })}\n`;
}

const KEEP_PLAIN = entry('merge T7 once the suite passes');
const KEEP_OTHER = entry(join('this one stays: ', OTHER_TOKEN));
const KEEP_CRLF = entry('a line Windows ended').replace('\n', '\r\n');
const DROP_DISPLAY = entry(join('use ', TOKEN, ' for CI'));
const DROP_PASTE = entry('[Pasted text #1]', { '1': { id: 1, type: 'text', content: join('creds https://app:', PASSWORD, '@db') } });
const DROP_CACHED = entry('[Pasted text #1 +40 lines]', { '1': { id: 1, type: 'text', contentHash: 'c0ffee' } });

/** A history file that Claude Code appends a prompt to after each of the first `appends` reads. */
class AppendingFiles extends MemoryFiles {
  private appends: number;

  constructor(initial: Readonly<Record<string, string>>, appends: number) {
    super(initial);
    this.appends = appends;
  }

  override async read(path: string): Promise<string | undefined> {
    const text = await super.read(path);
    if (path === places.history && this.appends > 0) {
      this.appends -= 1;
      await this.append(path, entry(`prompt written meanwhile ${this.appends}`));
    }
    return text;
  }
}

describe('cleanHistory', () => {
  it('removes each line and paste holding a wanted secret and keeps the rest byte for byte', async () => {
    const files = new MemoryFiles({
      [places.history]: [KEEP_PLAIN, DROP_DISPLAY, KEEP_OTHER, DROP_PASTE, 'not json at all\n', DROP_CACHED, KEEP_CRLF].join(''),
      [`${places.pasteCache}/c0ffee.txt`]: join('big paste\n', TOKEN, '\n'),
      [`${places.pasteCache}/beef.txt`]: 'another paste, nothing secret',
    });

    const result = await cleanHistory(files, places, secrets, wanted);

    assert.equal(files.get(places.history), [KEEP_PLAIN, KEEP_OTHER, 'not json at all\n', KEEP_CRLF].join(''));
    assert.equal(files.get(`${places.pasteCache}/c0ffee.txt`), undefined);
    assert.equal(files.get(`${places.pasteCache}/beef.txt`), 'another paste, nothing secret');
    assert.deepEqual({ lines: result.lines, pastes: result.pastes, settled: result.settled }, { lines: 3, pastes: 1, settled: true });
    assert.deepEqual([...result.hits].sort(), [...wanted].sort());
  });

  it('writes nothing when no line holds a wanted secret', async () => {
    const files = new MemoryFiles({ [places.history]: KEEP_PLAIN + KEEP_OTHER });
    const before = await files.stamp(places.history);

    const result = await cleanHistory(files, places, secrets, wanted);

    assert.equal(await files.stamp(places.history), before);
    assert.deepEqual({ lines: result.lines, pastes: result.pastes, hits: [...result.hits], settled: result.settled }, { lines: 0, pastes: 0, hits: [], settled: true });
  });

  it('plans again over a history that changed before the write, keeping the prompt written meanwhile', async () => {
    const files = new AppendingFiles({ [places.history]: KEEP_PLAIN + DROP_DISPLAY }, 1);

    const result = await cleanHistory(files, places, secrets, wanted);

    assert.equal(files.get(places.history), KEEP_PLAIN + entry('prompt written meanwhile 0'));
    assert.deepEqual({ lines: result.lines, settled: result.settled }, { lines: 1, settled: true });
  });

  it('leaves a history that changes under every attempt as it is, unsettled', async () => {
    const files = new AppendingFiles({ [places.history]: KEEP_PLAIN + DROP_DISPLAY }, 10);

    const result = await cleanHistory(files, places, secrets, wanted);

    assert.equal(files.get(places.history)?.startsWith(KEEP_PLAIN + DROP_DISPLAY), true);
    assert.deepEqual({ lines: result.lines, hits: [...result.hits], settled: result.settled }, { lines: 0, hits: [], settled: false });
  });

  it('finds nothing to do without a history or a paste cache', async () => {
    const result = await cleanHistory(new MemoryFiles(), places, secrets, wanted);

    assert.deepEqual({ lines: result.lines, pastes: result.pastes, settled: result.settled }, { lines: 0, pastes: 0, settled: true });
  });
});
