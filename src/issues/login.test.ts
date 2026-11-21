import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLogin } from './login.ts';

describe('isLogin', () => {
  it('takes letters, digits and single inner hyphens, up to 39 characters', () => {
    for (const login of ['a', 'octo-cat', 'Octo9', 'a'.repeat(39)]) {
      assert.equal(isLogin(login), true, login);
    }
  });

  it('refuses what could name another path or field', () => {
    for (const login of ['', '-octo', 'octo-', 'octo--cat', 'octo/cat', 'octo cat', 'octo?x=1', '..', 'a'.repeat(40)]) {
      assert.equal(isLogin(login), false, login);
    }
  });
});
