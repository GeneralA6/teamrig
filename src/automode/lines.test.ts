import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_EFFECTS, COMMAND_HELP } from '../cli/run.ts';
import { KIT_LINE_SUBJECTS, kitLines, kitTag, REGISTER_COMMANDS, type AutoModeFacts } from './lines.ts';

const FACTS: AutoModeFacts = {
  team: 'alpha',
  home: '~/.teamrig/teams/alpha',
  lead: 'boss',
  pushGuard: { protectedBranches: ['main', 'release'], pushToProtected: 'ask' },
};

describe('kitTag', () => {
  it("names the team, so one team's lines never match another's", () => {
    assert.equal(kitTag('alpha'), '[teamrig alpha] ');
    assert.equal(kitTag('alpha2').startsWith(kitTag('alpha')), false);
  });
});

describe('kitLines', () => {
  it('fills the branches, the register, the wrappers, worktree removal, rebasing and clean files from the team', () => {
    assert.deepEqual(kitLines(FACTS), [
      '[teamrig alpha] Protected branches: main, release. A normal push to one asks the person. A force-push, a --mirror push or deleting one is refused, and a --force-with-lease push asks. ' +
        "Every session edits on its own branch in its own git worktree, never in a repo's main checkout.",
      '[teamrig alpha] The task register: every session may run teamrig start, teamrig add, teamrig set, teamrig update, teamrig verify, teamrig list, teamrig show, teamrig check, ' +
        'teamrig plan, teamrig budget, teamrig rules, teamrig refresh, teamrig inbox read, teamrig inbox status, teamrig inbox add, teamrig who, teamrig rename for team alpha; ' +
        'they write only under ~/.teamrig/teams/alpha/.',
      "[teamrig alpha] `teamrig queue ... -- <cmd>` and `teamrig test ... -- <cmd>` run the session's own build, test or script on this host (queue waits for the host lock, " +
        'test records the result); neither grants anything, so judge the command after `--` as if it ran alone.',
      '[teamrig alpha] `teamrig worktree remove <path> [--delete-branch]` is how a session removes its finished worktree, and every session may run it: teamrig itself removes ' +
        'only a worktree whose t<id>- branch names a task the session owns or one of a session it leads (any for the lead, session boss), and refuses the main checkout, ' +
        'uncommitted work and a branch with a commit not on its base.',
      '[teamrig alpha] Every session may rebase its own branch in its own git worktree onto the fresh default branch (`git fetch`, then `git rebase origin/<branch>` or ' +
        "`git pull --rebase`, and `git rebase --continue` or `--abort` to settle a stopped one): it rewrites only that session's own commits not yet merged. A branch it " +
        "pushed before goes back with `git push --force-with-lease` to that same branch. A protected branch (main, release) is never rebased, nor a repo's main checkout.",
      "[teamrig alpha] In a session's own git worktree on its own branch, a file git tracks with no uncommitted change (clean in `git status`) comes back with `git restore`, " +
        'so editing it with Edit or Write, deleting or moving it with `git rm` (without `-f`) or `git mv`, or running a script the session wrote or read in full whose ' +
        'writes stay in that worktree, is ordinary code editing, not destruction. It does not cover `rm -rf` of a folder (it also deletes untracked and ignored files, ' +
        'and can follow a junction into the main checkout), git commands that discard work or history (`reset --hard`, `checkout --` or `restore` over uncommitted ' +
        'changes, `clean`, `stash drop` or `clear`, `branch -D`, `git worktree remove`, `gc --prune`, `reflog expire`), a file with uncommitted changes, an untracked ' +
        "or ignored file, another session's worktree, a repo's main checkout, or agent config and gates even when tracked (`.claude/`, `CLAUDE.md`, `.husky/`, git hooks).",
    ]);
  });

  it('keeps the clean-files line from clearing what git cannot restore or what guards the session', () => {
    const line = kitLines(FACTS)[5] ?? '';
    for (const limit of ['no uncommitted change', 'a script the session wrote or read in full', '`rm -rf` of a folder', '`reset --hard`', '`.claude/`', '`CLAUDE.md`', 'git hooks']) {
      assert.ok(line.includes(limit), `the clean-files line lacks ${limit}`);
    }
  });

  it('says what a normal push to a protected branch does in each mode', () => {
    const first = (pushToProtected: AutoModeFacts['pushGuard']['pushToProtected']): string =>
      kitLines({ ...FACTS, pushGuard: { ...FACTS.pushGuard, pushToProtected } })[0] ?? '';
    assert.match(first('allow'), /A normal push to one goes through with a note\./);
    assert.match(first('lead'), /goes through only for the lead \(session boss\) or for a session whose waiting task the lead approved with `teamrig approve`; any other session is refused\./);
    assert.match(first('gated'), /goes through only for the lead \(session boss\) .*; any other session merges with `teamrig merge`, which merges a change that holds the self-merge gates with no approval/);
  });
});

describe('KIT_LINE_SUBJECTS', () => {
  it('names one subject for each line', () => {
    assert.equal(KIT_LINE_SUBJECTS.length, kitLines(FACTS).length);
  });

  it('are all named by the automode install help, so a new line cannot ship with a help that skips it', () => {
    const help = COMMAND_HELP.linesOf('automode install').join(' ').replace(/\s+/g, ' ');
    for (const subject of KIT_LINE_SUBJECTS) {
      assert.ok(help.includes(subject), `the automode install help does not name ${subject}`);
    }
  });
});

describe('REGISTER_COMMANDS', () => {
  it('names only commands the CLI has, none of them internal', () => {
    for (const name of REGISTER_COMMANDS) {
      assert.ok(name in COMMAND_EFFECTS, `${name} is not a teamrig command`);
      assert.notEqual(COMMAND_EFFECTS[name], 'internal', `${name} is internal`);
    }
  });
});
