import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_EXIT,
  CANCEL_CHOICE,
  capLines,
  changedText,
  failureText,
  MAX_CHARS,
  MAX_ERROR_LINES,
  MAX_LINES,
  notRunText,
  resultText,
  RUN_CHOICE,
  SlashHand,
  slashCliArgv,
  type SlashHandHost,
  type SlashRun,
} from './slash-hand.ts';

const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const CWD = '/work/app/sub';
const ROOT = '/work/app';

/** A run that printed `stdout` and ended with `exitCode`. */
function ran(stdout: string, exitCode = 0, stderr = ''): SlashRun {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false };
}

interface CliCall {
  readonly stdin: unknown;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Claude Code as the hand sees it: one tab, the CLI's answers in order, and the person's choice. */
class FakeHost implements SlashHandHost {
  /** What each CLI run gives back, in order; an Error is a run that did not start or finish. */
  runs: (SlashRun | Error)[] = [ran('ok\n')];
  readonly calls: CliCall[] = [];
  /** The person's choice, or why the dialog closed without one. */
  choice: string | Error = RUN_CHOICE;
  readonly questions: { readonly question: string; readonly options: readonly string[] }[] = [];
  /** Every status line set, undefined for a clear. */
  readonly statuses: (string | undefined)[] = [];

  async sessionId(): Promise<string> {
    return SESSION;
  }

  async cwd(): Promise<string> {
    return CWD;
  }

  async root(): Promise<string> {
    return ROOT;
  }

  async cli(stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<SlashRun> {
    this.calls.push({ stdin: JSON.parse(stdin), env, cwd });
    const next = this.runs.shift();
    if (next === undefined) {
      throw new Error('no run left');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async ask(question: string, options: readonly string[]): Promise<string> {
    this.questions.push({ question, options });
    if (this.choice instanceof Error) {
      throw this.choice;
    }
    return this.choice;
  }

  status(text: string | undefined): void {
    this.statuses.push(text);
  }
}

describe('SlashHand.answer', () => {
  it('runs the CLI with the tab session, folder, root, the typed text and its origin, and shows the typed line, then the output fenced under it', async () => {
    const host = new FakeHost();
    host.runs = [ran('line one\nline two\n')];
    const answer = await new SlashHand(host).answer('budget', 'composer');
    // T801: the tab shows the answer after a `teamrig: ` prefix; a fence opening the text would sit mid-line there.
    assert.deepEqual(answer, { text: 'teamrig budget\n```text\nline one\nline two\n```', exitCode: 0 });
    assert.deepEqual(host.calls, [
      { stdin: { session_id: SESSION, cwd: CWD, args: 'budget', origin: 'composer' }, env: { CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: ROOT }, cwd: CWD },
    ]);
    assert.deepEqual(host.statuses, ['teamrig budget: running', undefined]);
    assert.deepEqual(host.questions, []);
  });

  it("passes the CLI's exit code on, for a headless claude -p run", async () => {
    const host = new FakeHost();
    host.runs = [ran('', 2, 'REFUSED no\n')];
    const answer = await new SlashHand(host).answer('set T1 --status done', 'sdk');
    assert.equal(answer.exitCode, 2);
    assert.equal(answer.text, 'teamrig set T1 --status done\n```text\nREFUSED no\n```\nteamrig set T1 --status done ended with exit code 2.');
  });

  it('asks the person before a line the CLI printed to agree to, then runs that line', async () => {
    const host = new FakeHost();
    host.runs = [ran('teamrig inbox read --session alpha\n', ASK_EXIT), ran("--session alpha (this tab's session)\nhello\n")];
    const answer = await new SlashHand(host).answer('inbox read', 'composer');
    assert.deepEqual(host.questions, [{ question: 'Run teamrig inbox read --session alpha?', options: [RUN_CHOICE, CANCEL_CHOICE] }]);
    assert.deepEqual(
      host.calls.map((call) => call.stdin),
      [
        { session_id: SESSION, cwd: CWD, args: 'inbox read', origin: 'composer' },
        { session_id: SESSION, cwd: CWD, args: 'inbox read', origin: 'composer', agreed: 'teamrig inbox read --session alpha' },
      ],
    );
    assert.deepEqual(answer, { text: "teamrig inbox read\n```text\n--session alpha (this tab's session)\nhello\n```", exitCode: 0 });
    assert.deepEqual(host.statuses, ['teamrig inbox read: running', undefined, 'teamrig inbox read: running', undefined]);
  });

  it('runs nothing more when the person cancels, types something else or closes the dialog', async () => {
    for (const choice of [CANCEL_CHOICE, 'run it please', new Error('dismissed')]) {
      const host = new FakeHost();
      host.runs = [ran('teamrig inbox read --session alpha\n', ASK_EXIT)];
      host.choice = choice;
      const answer = await new SlashHand(host).answer('inbox read', 'composer');
      assert.deepEqual(answer, { text: notRunText('teamrig inbox read --session alpha'), exitCode: ASK_EXIT });
      assert.equal(host.calls.length, 1);
    }
  });

  it('runs nothing when the line changed while the person was asked', async () => {
    const host = new FakeHost();
    host.runs = [ran('teamrig inbox read --session alpha\n', ASK_EXIT), ran('teamrig inbox read --session bravo\n', ASK_EXIT)];
    const answer = await new SlashHand(host).answer('inbox read', 'composer');
    assert.deepEqual(answer, { text: changedText('teamrig inbox read --session bravo'), exitCode: ASK_EXIT });
    assert.equal(host.questions.length, 1);
  });

  it('says the command did not finish when the CLI cannot start or times out, and clears the status', async () => {
    const host = new FakeHost();
    host.runs = [new Error('timed out')];
    const answer = await new SlashHand(host).answer(' budget ', 'composer');
    assert.deepEqual(answer, { text: failureText(' budget ', new Error('timed out')), exitCode: 1 });
    assert.deepEqual(host.statuses, ['teamrig budget: running', undefined]);
  });
});

describe('resultText', () => {
  it('says a run that printed nothing is done', () => {
    assert.equal(resultText('', ran('\n')), 'teamrig: done, nothing printed.');
  });

  it('shows a failed run with no output by its exit code alone', () => {
    assert.equal(resultText('x', ran('', 1)), 'teamrig x ended with exit code 1.');
  });

  it('fences with more backticks than any run in the output', () => {
    assert.equal(resultText('show T1', ran('a ```` b')), 'teamrig show T1\n`````text\na ```` b\n`````');
  });

  it('counts the lines left out and points to a terminal', () => {
    const text = resultText('list', ran(Array.from({ length: MAX_LINES + 5 }, (_, index) => `row ${index}`).join('\n')));
    assert.ok(text.endsWith('\n```\n5 more lines not shown: run teamrig list in a terminal for all of it.'));
  });

  it('says output Claude Code cut is not all shown', () => {
    assert.ok(resultText('list', { ...ran('a'), isStdoutTruncated: true }).endsWith('More output not shown: run teamrig list in a terminal for all of it.'));
  });

  it('caps the error output of a failed run and says so, and ignores it on a run that passed', () => {
    const stderr = Array.from({ length: MAX_ERROR_LINES + 1 }, () => 'err').join('\n');
    assert.ok(resultText('x', ran('', 1, stderr)).includes('More error output not shown.'));
    assert.ok(resultText('x', { ...ran('', 1, 'e'), isStderrTruncated: true }).includes('More error output not shown.'));
    assert.equal(resultText('x', ran('out', 0, 'warning')), 'teamrig x\n```text\nout\n```');
  });
});

describe('capLines', () => {
  it('keeps whole lines within the character limit', () => {
    assert.deepEqual(capLines('ab\ncd\nef', 10, 4), { kept: 'ab', hidden: 2 });
    assert.deepEqual(capLines('ab\ncd\nef', 10, 5), { kept: 'ab\ncd', hidden: 1 });
    assert.deepEqual(capLines('x'.repeat(MAX_CHARS + 1), MAX_LINES, MAX_CHARS), { kept: '', hidden: 1 });
  });
});

describe('slashCliArgv', () => {
  it("runs the plugin's built CLI as hook slash-command", () => {
    assert.deepEqual(slashCliArgv('/plugins/teamrig'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'slash-command']);
  });
});

describe('failureText', () => {
  it('names a thrown value that is not an Error', () => {
    assert.equal(failureText('x', 'gone'), 'teamrig x did not finish: gone. A command is stopped after 180 s; a terminal runs it with no limit.');
  });
});
