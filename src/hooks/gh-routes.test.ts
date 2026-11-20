import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_EFFECTS } from '../cli/run.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { ASK_LEAD, GH_WRITE_ROUTES, ghRouteOf } from './gh-routes.ts';

/** The words of a gh call after `gh`; a word holding `$` is only known when it runs. */
function words(line: string): ShellWord[] {
  return line === '' ? [] : line.split(' ').map((text) => ({ text, dynamic: text.includes('$') }));
}

function routeOf(line: string): string {
  return ghRouteOf(words(line));
}

describe('ghRouteOf (T4819)', () => {
  it('names the teamrig command for each gh write it has one for', () => {
    for (const [line, command] of [
      ['issue comment 7 --body hi', 'teamrig issue reply'],
      ['pr comment 3 --body-file f.md', 'teamrig issue reply'],
      ['issue close 7', 'teamrig issue close'],
      ['pr close 3', 'teamrig issue close'],
      ['issue edit 7 --add-label bug', 'teamrig issue label'],
      ['pr edit 3 --add-assignee me', 'teamrig issue assign'],
      ['issue create --title x', 'teamrig add'],
      ['pr create --fill', 'teamrig merge'],
      ['pr merge 3 --rebase', 'teamrig merge'],
    ] as const) {
      assert.ok(routeOf(line).includes(`\`${command}`), `${line}: ${routeOf(line)}`);
    }
  });

  it('names the teamrig command for a gh api write by the repository path it reaches', () => {
    for (const [line, command] of [
      ['api repos/acme/web/issues/7/comments -f body=hi', 'teamrig issue reply'],
      ['api -X POST repos/acme/web/issues/7/labels -f labels[]=bug', 'teamrig issue label'],
      ['api -X DELETE repos/acme/web/issues/7/labels/bug', 'teamrig issue label'],
      ['api repos/acme/web/issues/7/assignees -f assignees[]=me', 'teamrig issue assign'],
      ['api -X PATCH repos/acme/web/issues/7 -f state=closed', 'teamrig issue edit'],
      ['api -X PATCH https://api.github.com/repos/acme/web/pulls/3 -f title=x', 'teamrig issue edit'],
      ['api repos/acme/web/issues -f title=x', 'teamrig add'],
      ['api repos/acme/web/pulls -f head=x -f base=main', 'teamrig merge'],
      ['api -X PUT repos/acme/web/pulls/3/merge', 'teamrig merge'],
    ] as const) {
      assert.ok(routeOf(line).includes(`\`${command}`), `${line}: ${routeOf(line)}`);
    }
  });

  it('sends every other write to the lead, and a call it cannot read', () => {
    for (const line of [
      'pr review 3 --approve',
      'release create v1',
      'workflow run ci.yml',
      'issue $VERB 7',
      '$GROUP close 7',
      'api repos/acme/web/git/refs -f ref=x',
      'api $ENDPOINT -f x=1',
      'api graphql -f query=mutation{closeIssue}',
      '',
    ]) {
      assert.equal(routeOf(line), ASK_LEAD, line);
    }
  });

  it('names only teamrig commands the CLI has', () => {
    const named = [...GH_WRITE_ROUTES.values()].flatMap((route) => [...route.matchAll(/`teamrig ([a-z-]+(?: [a-z-]+)?)/gu)].map((match) => match[1] ?? ''));
    assert.ok(named.length > 0);
    for (const command of new Set(named)) {
      assert.ok(command in COMMAND_EFFECTS, command);
    }
  });
});
