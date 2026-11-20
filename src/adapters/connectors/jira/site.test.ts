import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl, browseUrl, credentialName, issueKey, issueNumber, parseProject, projectProblem } from './site.ts';

describe('parseProject', () => {
  it('reads <site>/<project key>, the key in capitals as Jira spells it', () => {
    assert.deepEqual(parseProject('acme/eng'), { site: 'acme', key: 'ENG' });
    assert.deepEqual(parseProject('acme-labs-2/web_app2'), { site: 'acme-labs-2', key: 'WEB_APP2' });
    assert.deepEqual(parseProject('a/b'), { site: 'a', key: 'B' });
  });

  it('refuses a site that could spell another host, so the sign-in header goes to atlassian.net alone', () => {
    for (const repo of ['evil.example/eng', 'acme.atlassian.net/eng', 'acme:8443/eng', 'acme@evil/eng', '-acme/eng', 'acme-/eng', 'ACME/eng', `${'a'.repeat(64)}/eng`]) {
      assert.equal(parseProject(repo), undefined, repo);
    }
  });

  it('refuses a text that is not one site and one key', () => {
    for (const repo of ['', 'acme', 'acme/', '/eng', 'acme/eng/extra', 'acme/1eng', 'acme/ENG', 'acme/e-ng', 'acme/eng#12']) {
      assert.equal(parseProject(repo), undefined, repo);
    }
  });

  it('says how a project is written when the text names none', () => {
    assert.equal(projectProblem('acme'), '"acme" is not a Jira project: write it as <site>/<project key>, the site being the name before .atlassian.net');
  });
});

describe('a Jira project', () => {
  const project = { site: 'acme', key: 'ENG' };

  it('is reached at its site, REST API version 3, with the credential saved for that site', () => {
    assert.equal(baseUrl('acme'), 'https://acme.atlassian.net/rest/api/3');
    assert.equal(credentialName('acme'), 'teamrig-jira-acme');
  });

  it('names an issue by its key and its page', () => {
    assert.equal(issueKey(project, 12), 'ENG-12');
    assert.equal(browseUrl(project, 12), 'https://acme.atlassian.net/browse/ENG-12');
  });

  it("reads an issue's number from its key, only when the key is the project's own", () => {
    assert.equal(issueNumber(project, 'ENG-12'), 12);
    assert.equal(issueNumber(project, 'ENG-4000000000'), 4_000_000_000);
    for (const key of ['OPS-12', 'ENG-', 'ENG-0', 'ENG-012', 'ENG-1x', 'ENG-12345678901', 'eng-12', 'ENGX-1', '12']) {
      assert.equal(issueNumber(project, key), undefined, key);
    }
  });
});
