import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { endpointPath, GH_READS, ghCallOf, mayBeGhCall, remoteReposOf, repoFlagValue, repoInWord, type GhCall } from './gh-writes.ts';

/** The words of a gh call after `gh`; a word holding `$` is only known when it runs. */
function words(line: string): ShellWord[] {
  return line === '' ? [] : line.split(' ').map((text) => ({ text, dynamic: text.includes('$') }));
}

function callOf(line: string): GhCall {
  return ghCallOf(words(line));
}

const READ: GhCall = { kind: 'read' };

function write(what: string, repos: readonly string[], folder: boolean): GhCall {
  return { kind: 'write', what, target: { repos, folder } };
}

describe('ghCallOf: reads (T3002)', () => {
  it('reads every command on the allowlist of its group, and gh alone, a group alone and a whole read group', () => {
    for (const [group, commands] of GH_READS) {
      for (const command of commands) {
        assert.deepEqual(callOf(`${group} ${command} x`), READ, `${group} ${command}`);
      }
    }
    for (const line of ['', 'pr', 'issue', 'search issues is:open', 'status', 'browse 7', 'attestation verify x', 'co 3', 'help pr', '--version', '-h']) {
      assert.deepEqual(callOf(line), READ, line);
    }
  });

  it('reads a gh api GET with no body and a GraphQL query, wherever it points', () => {
    for (const line of ['api repos/a/b/pulls/3', 'api -X GET repos/a/b/issues -f state=open', 'api user', 'api', 'api graphql -f query={viewer{login}}', 'api https://api.github.com/graphql -f query={viewer{login}}']) {
      assert.deepEqual(callOf(line), READ, line);
    }
  });

  it('reads a command past -R/--repo flags before it, and a help flag there, as gh does', () => {
    for (const line of ['pr -R acme/web view 3', 'pr --repo=acme/web list', 'issue -Racme/web status', 'pr --help merge 3', 'issue -h']) {
      assert.deepEqual(callOf(line), READ, line);
    }
  });

  it('cannot place any call whose group is only known when it runs, a read command too (R4)', () => {
    for (const line of ['$G list', '$G view 3', '$G close 3', '$G']) {
      assert.deepEqual(callOf(line), { kind: 'unplaced', what: 'gh $G', why: 'its group is only known when it runs' }, line);
    }
  });
});

describe('ghCallOf: writes placed on a repository (T3002)', () => {
  it('reads every other command of a repository group as a write: on its -R repository, else the folder’s', () => {
    for (const [line, what] of [
      ['pr create --fill', 'gh pr create'],
      ['issue create --title x', 'gh issue create'],
      ['issue close 7', 'gh issue close'],
      ['pr merge 3 --rebase', 'gh pr merge'],
      ['release create v1', 'gh release create'],
      ['label create bug', 'gh label create'],
      ['workflow run ci.yml', 'gh workflow run'],
      ['run rerun 9', 'gh run rerun'],
      ['secret set KEY', 'gh secret set'],
      ['repo edit --enable-wiki=false', 'gh repo edit'],
    ] as const) {
      assert.deepEqual(callOf(line), write(what, [], true), line);
    }
    assert.deepEqual(callOf('issue close 7 -R Acme/Web'), write('gh issue close', ['acme/web'], false));
    assert.deepEqual(callOf('pr merge 3 --repo=github.com/acme/web'), write('gh pr merge', ['acme/web'], false));
    assert.deepEqual(callOf('pr merge 3 -Racme/web --repo https://github.com/acme/api.git'), write('gh pr merge', ['acme/web', 'acme/api'], false));
  });

  it('places a write on a -R/--repo given before its command, in each of gh’s spellings (R1)', () => {
    for (const line of ['pr --repo=acme/web merge 5', 'pr -Racme/web merge 5', 'pr -R acme/web merge 5', 'pr --repo acme/web merge 5']) {
      assert.deepEqual(callOf(line), write('gh pr merge', ['acme/web'], false), line);
    }
    assert.deepEqual(callOf('issue -R acme/web --repo=acme/api close 7'), write('gh issue close', ['acme/web', 'acme/api'], false));
  });

  it('cannot read the command past another flag, or a word only known when it runs, before it (R1)', () => {
    assert.deepEqual(callOf('pr --verbose merge 5'), { kind: 'unplaced', what: 'gh pr', why: '`--verbose` before its command may hide which command it is' });
    for (const line of ['pr -R $R view 3', 'pr --repo=$R list']) {
      assert.deepEqual(callOf(line), { kind: 'unplaced', what: 'gh pr', why: 'a word only known when it runs, before its command, may change which command it is' }, line);
    }
  });

  it('adds each repository a word names: a URL in place of a number, a repository positional, a transfer’s target', () => {
    assert.deepEqual(callOf('pr merge https://github.com/acme/web/pull/3'), write('gh pr merge', ['acme/web'], true));
    assert.deepEqual(callOf('repo delete acme/old --yes'), write('gh repo delete', ['acme/old'], true));
    assert.deepEqual(callOf('issue transfer 7 acme/api -R acme/web'), write('gh issue transfer', ['acme/web', 'acme/api'], false));
  });

  it('places a gh api write by its repos/<owner>/<name> path, and gh’s {owner}/{repo} on the folder’s repository', () => {
    for (const [line, what, repo] of [
      ['api -X PATCH repos/a/b/issues/7 -f state=closed', 'gh api PATCH repos/a/b/issues/7', 'a/b'],
      ['api repos/a/b/git/refs -f ref=refs/heads/x -f sha=1', 'gh api POST repos/a/b/git/refs', 'a/b'],
      ['api -X DELETE https://api.github.com/repos/A/B/git/refs/heads/x', 'gh api DELETE https://api.github.com/repos/A/B/git/refs/heads/x', 'a/b'],
      ['api -XPOST repos/a/b/releases -f tag=v1', 'gh api POST repos/a/b/releases', 'a/b'],
    ] as const) {
      assert.deepEqual(callOf(line), write(what, [repo], false), line);
    }
    assert.deepEqual(callOf('api repos/{owner}/{repo}/issues/7/comments -f body=hi'), write('gh api POST repos/{owner}/{repo}/issues/7/comments', [], true));
  });

  it('places gh’s :owner/:repo placeholders on the folder’s repository, mixed with {owner}/{repo} too (R2)', () => {
    assert.deepEqual(callOf('api -X PUT repos/:owner/:repo/pulls/5/merge'), write('gh api PUT repos/:owner/:repo/pulls/5/merge', [], true));
    assert.deepEqual(callOf('api -X PUT repos/{owner}/:repo/pulls/5/merge'), write('gh api PUT repos/{owner}/:repo/pulls/5/merge', [], true));
  });
});

describe('ghCallOf: writes it cannot place (T3002)', () => {
  it('cannot place a write with a word only known when it runs, or a -R that names no repository', () => {
    assert.deepEqual(callOf('issue comment 7 --body $MSG'), { kind: 'unplaced', what: 'gh issue comment', why: 'a word only known when it runs may name another repository' });
    assert.deepEqual(callOf('pr $DO 3'), { kind: 'unplaced', what: 'gh pr $DO', why: 'its command is only known when it runs' });
    assert.deepEqual(callOf('pr merge 3 -R web'), { kind: 'unplaced', what: 'gh pr merge', why: 'its `-R` value names no repository' });
    assert.deepEqual(callOf('pr merge 3 -R'), { kind: 'unplaced', what: 'gh pr merge', why: 'its `-R` value names no repository' });
  });

  it('cannot place an organization’s or user’s secret, variable or ruleset write, an account write, or one on gh itself', () => {
    for (const line of ['secret set KEY --org acme', 'variable set V -oacme', 'secret set KEY --user', 'ruleset delete --org=acme 1']) {
      assert.deepEqual(callOf(line), { kind: 'unplaced', what: `gh ${line.split(' ').slice(0, 2).join(' ')}`, why: 'it writes on an organization or user, outside any one repository' }, line);
    }
    assert.deepEqual(callOf('ruleset view --org=acme 1'), READ);
    assert.deepEqual(callOf('gist create f.txt'), { kind: 'unplaced', what: 'gh gist create', why: 'it writes on the GitHub account, outside any one repository' });
    assert.deepEqual(callOf('ssh-key add k.pub'), { kind: 'unplaced', what: 'gh ssh-key add', why: 'it writes on the GitHub account, outside any one repository' });
    assert.deepEqual(callOf('auth token'), { kind: 'unplaced', what: 'gh auth token', why: "it changes gh's own login, settings, aliases or extensions" });
    assert.deepEqual(callOf('config set editor x'), { kind: 'unplaced', what: 'gh config set', why: "it changes gh's own login, settings, aliases or extensions" });
  });

  it('cannot place an alias or extension, a flag before the command, a GraphQL mutation or a write outside repos/', () => {
    assert.deepEqual(callOf('mymerge 3'), { kind: 'unplaced', what: 'gh mymerge', why: 'gh runs it as an alias or an extension, which the guard cannot read' });
    assert.deepEqual(callOf('-R acme/web pr merge'), { kind: 'unplaced', what: 'gh -R acme/web', why: 'gh takes no flag before its command' });
    for (const line of ['api graphql -f query=mutation{closeIssue}', 'api graphql -F query=@q.graphql', 'api graphql --input q.json', 'api graphql -f query=$Q', 'api graphql -X $M -f query={viewer{login}}']) {
      assert.equal(callOf(line).kind, 'unplaced', line);
    }
    for (const endpoint of ['https://api.github.com/graphql', 'HTTPS://API.GITHUB.COM/GraphQL', 'https://ghe.example.com/api/graphql', '/graphql', '//graphql/', 'GRAPHQL', 'graphql?x=1']) {
      assert.deepEqual(callOf(`api ${endpoint} -f query=mutation{closeIssue}`), { kind: 'unplaced', what: `gh api ${endpoint}`, why: 'a GraphQL mutation can reach any repository the login reaches' }, endpoint);
    }
    assert.deepEqual(callOf('api -X PUT user/following/x'), { kind: 'unplaced', what: 'gh api PUT user/following/x', why: 'its endpoint is no `repos/<owner>/<name>` path, so it writes outside any one repository' });
    assert.deepEqual(callOf('api repos/{owner}/x/issues -f a=b'), { kind: 'unplaced', what: 'gh api POST repos/{owner}/x/issues', why: 'its endpoint is no `repos/<owner>/<name>` path, so it writes outside any one repository' });
  });

  it('cannot place a gh api endpoint with any other placeholder-shaped owner or name (R2)', () => {
    for (const endpoint of ['repos/{owner}/x/issues', 'repos/:owner/x/issues', 'repos/x/:repo/issues', 'repos/:org/:repo/issues', 'repos/{branch}/{repo}/issues']) {
      assert.deepEqual(callOf(`api ${endpoint} -f a=b`), { kind: 'unplaced', what: `gh api POST ${endpoint}`, why: 'its endpoint is no `repos/<owner>/<name>` path, so it writes outside any one repository' }, endpoint);
    }
  });

  it('cannot place a gh api call with any word only known when it runs, a read-looking one too (R3)', () => {
    const why = 'a word only known when it runs may set its method or its endpoint';
    assert.deepEqual(callOf('api "$M" repos/acme/web/pulls/5/merge'), { kind: 'unplaced', what: 'gh api "$M"', why });
    assert.deepEqual(callOf('api $E'), { kind: 'unplaced', what: 'gh api $E', why });
    assert.deepEqual(callOf('api $URL -f body=hi'), { kind: 'unplaced', what: 'gh api $URL', why });
    assert.deepEqual(callOf('api -X $M repos/a/b/issues/7'), { kind: 'unplaced', what: 'gh api repos/a/b/issues/7', why });
    for (const line of ['api repos/acme/web/pulls -q $Q', 'api repos/acme/web/pulls -H $H', 'api repos/acme/web/pulls/$N']) {
      assert.deepEqual(callOf(line), { kind: 'unplaced', what: `gh api ${line.split(' ')[1] ?? ''}`, why }, line);
    }
  });

  it('cannot place a gh api write whose path has a `.`, `..` or `%` segment (N1)', () => {
    for (const endpoint of ['repos/x/y/../../acme/web/pulls/5/merge', 'repos/./acme/web/issues', 'repos/acme%2fweb/x/issues', 'repos/acme/web/issues/%2e%2e']) {
      assert.deepEqual(callOf(`api -X POST ${endpoint}`), { kind: 'unplaced', what: `gh api POST ${endpoint}`, why: 'its endpoint has a `.`, `..` or `%` segment, which may reach another path' }, endpoint);
    }
    assert.deepEqual(callOf('api repos/x/y/../../acme/web/pulls'), READ);
  });
});

describe('repository names (T3002)', () => {
  it('reads a -R value as OWNER/REPO, HOST/OWNER/REPO or a URL, and nothing else', () => {
    assert.equal(repoFlagValue('Acme/Web'), 'acme/web');
    assert.equal(repoFlagValue('github.com/acme/web'), 'acme/web');
    assert.equal(repoFlagValue('https://github.com/acme/web.git'), 'acme/web');
    for (const text of ['web', 'a/b/c/d', '', 'a b/c']) {
      assert.equal(repoFlagValue(text), undefined, text);
    }
  });

  it('reads a repository in a URL, an owner/name or an owner/name#number word, and none in a longer path', () => {
    assert.equal(repoInWord('https://github.com/Acme/Web/pull/3'), 'acme/web');
    assert.equal(repoInWord('acme/web#7'), 'acme/web');
    assert.equal(repoInWord('acme/web'), 'acme/web');
    for (const text of ['docs/guides/x.md', '7', 'https://github.com', '--body']) {
      assert.equal(repoInWord(text), undefined, text);
    }
  });

  it('knows an unnamed program’s words may be a gh call only when they start with a gh group or a word known when it runs', () => {
    assert.equal(mayBeGhCall(words('pr merge 3')), true);
    assert.equal(mayBeGhCall(words('$X close 3')), false);
    assert.equal(mayBeGhCall(words('notes.txt')), false);
    assert.equal(mayBeGhCall([]), false);
  });
});

describe('endpointPath (T2705)', () => {
  it('drops the scheme and host, the query, slashes at either end and the case', () => {
    assert.equal(endpointPath('https://api.github.com/graphql'), 'graphql');
    assert.equal(endpointPath('/repos/A/B/issues/7/?per_page=1#x'), 'repos/a/b/issues/7');
    assert.equal(endpointPath('graphql'), 'graphql');
  });
});

describe('remoteReposOf (T3002)', () => {
  it('reads the GitHub repositories a git remote -v listing names, once each, and none off github.com', () => {
    const listing = ['origin\thttps://github.com/Acme/Web.git (fetch)', 'origin\thttps://github.com/Acme/Web.git (push)', 'fork\thttps://github.com/someone/web (fetch)', 'mirror\thttps://gitlab.example.com/acme/web.git (fetch)', ''].join('\r\n');
    assert.deepEqual(remoteReposOf(listing), ['acme/web', 'someone/web']);
    assert.deepEqual(remoteReposOf(''), []);
  });

  it('reads remotes plainly off GitHub as naming none: another host, a folder, a file URL (R5)', () => {
    const listing = ['a\tgit@gitlab.example.com:acme/web.git (fetch)', 'b\t/srv/git/web.git (fetch)', 'c\tC:/repos/web (fetch)', 'd\tfile:///srv/web (fetch)', 'e\t../web (fetch)', 'f\thttps://github.com/acme/web (push)'].join('\n');
    assert.deepEqual(remoteReposOf(listing), ['acme/web']);
  });

  it('cannot tell a folder’s repositories when a remote may reach GitHub in a form it cannot read (R5)', () => {
    for (const url of ['git@work-gh:acme/web.git', 'ssh://git@github.com:22/acme/web.git', 'https://www.github.com/acme/web', 'git@github.com-work:acme/web.git', 'ext::ssh', 'localhost:acme/web']) {
      assert.equal(remoteReposOf(`origin\thttps://github.com/someone/web (fetch)\nwork\t${url} (fetch)`), undefined, url);
    }
  });
});
