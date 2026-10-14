import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathKey, samePath } from './paths.ts';

describe('samePath', () => {
  it('ignores case, separators and a trailing separator on Windows', () => {
    assert.ok(samePath('C:\\Work\\App\\', 'c:/work/app', 'win32'));
    assert.ok(samePath('C:\\work\\src\\..\\app', 'C:\\WORK\\APP', 'win32'));
    assert.ok(!samePath('C:\\work\\app', 'D:\\work\\app', 'win32'));
  });

  it('ignores case on macOS, which uses POSIX paths', () => {
    assert.ok(samePath('/Srv/Work/App/', '/srv/work/app', 'darwin'));
    assert.ok(!samePath('/srv/work/app', '/srv/work/api', 'darwin'));
  });

  it('keeps case on Linux', () => {
    assert.ok(samePath('/srv/work/app/', '/srv/work/./app', 'linux'));
    assert.ok(!samePath('/srv/work/App', '/srv/work/app', 'linux'));
  });
});

describe('pathKey', () => {
  it('is the resolved path, lowercased only where case is ignored', () => {
    assert.equal(pathKey('C:\\Work\\App\\', 'win32'), 'c:\\work\\app');
    assert.equal(pathKey('/Srv/Work/App/', 'darwin'), '/srv/work/app');
    assert.equal(pathKey('/srv/Work/App/', 'linux'), '/srv/Work/App');
  });
});
