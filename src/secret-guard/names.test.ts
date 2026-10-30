import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';
import type { SecretGuardConfig } from '../config/types.ts';
import { secretRulesOf } from './rules.ts';

const names = new SecretNames(DEFAULT_SECRET_ENV_NAMES);

describe('SecretNames', () => {
  it('takes tokens, passwords, keys, credentials and connection strings as secret', () => {
    const secret = [
      'GITHUB_TOKEN',
      'npm_token',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'PGPASSWORD',
      'DB_PASS',
      'GPG_PASSPHRASE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'NPM_AUTH',
      'SSH_PRIVATE_KEY',
      'OPENAI_API_KEY',
      'APIKEY',
      'SENTRY_DSN',
      'GRAPHDB_URI_PRIMARY',
      'DATABASE_URL',
      'CACHE_URL',
      'PG_URL',
      'CONNECTION_STRING',
      'SLACK_WEBHOOK_URL',
      'SESSION_COOKIE',
      'GH_PAT',
      'PASSWORD_SALT',
    ];
    assert.deepEqual(secret.filter((name) => !names.secret(name)), []);
  });

  it('keeps everyday names printable', () => {
    const plain = ['HOME', 'PATH', 'USER', 'NODE_ENV', 'GIT_AUTHOR_NAME', 'SSH_AUTH_SOCK', 'KEYCLOAK_REALM', 'PATHEXT', 'PORT', 'API_URL', 'FEEDBACK_URL', 'UPGRADE_URL'];
    assert.deepEqual(plain.filter((name) => names.secret(name)), []);
  });

  it('keeps the name of an auth mechanism or source printable, which says how one signs in', () => {
    const plain = ['DB_AUTH_MECHANISM', 'authMechanism', 'authMechanismProperties', 'AUTH_SOURCE', 'authSource'];
    assert.deepEqual(plain.filter((name) => names.secret(name)), []);
  });

  it('lets a team add a name, and keep one printable with a later !pattern', () => {
    const team = new SecretNames([...DEFAULT_SECRET_ENV_NAMES, '^STRIPE_', '!^TOKENIZERS_']);
    assert.equal(team.secret('STRIPE_LIVE'), true);
    assert.equal(team.secret('TOKENIZERS_PARALLELISM'), false);
    assert.equal(team.secret('HF_TOKEN'), true);
  });
});

describe('secretRulesOf', () => {
  it('puts the team globs after the defaults, and ignores case only where the host does', () => {
    const config: SecretGuardConfig = { secretReads: 'deny', writes: 'deny', paths: ['!**/fixtures/*.pem'], envNames: [], commands: [], redact: true };
    const windows = secretRulesOf(config, 'C:/u', 'win32');
    assert.equal(windows.paths.listed('C:/r/test/fixtures/a.pem'), false);
    assert.equal(windows.paths.listed('C:/r/A.PEM'), true);
    assert.equal(secretRulesOf(config, '/u', 'linux').paths.listed('/r/A.PEM'), false);
  });

  it('puts the team commands after the default ones, so a !pattern lets a default command print', () => {
    const config: SecretGuardConfig = { secretReads: 'deny', writes: 'deny', paths: [], envNames: [], commands: ['^vault\\s+read\\s', '!--minify'], redact: true };
    const { commands } = secretRulesOf(config, 'C:/u', 'win32');
    assert.equal(commands.matches('kubectl config view --raw'), true);
    assert.equal(commands.matches('vault read secret/app'), true);
    assert.equal(commands.matches('kubectl config view --minify --raw'), false);
  });
});
