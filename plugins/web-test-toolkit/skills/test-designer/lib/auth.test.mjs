import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startFixture, USERS } from '../test-fixtures/app.mjs';
import { testerSignsIn } from '../test-fixtures/tester.mjs';
import { login, LoginError, missingSessions, sessionPath } from './auth.mjs';

const stateDir = () => mkdtempSync(path.join(tmpdir(), 'webtest-auth-'));

test('missingSessions names only the roles without a saved session', () => {
  const dir = stateDir();
  writeFileSync(sessionPath(dir, 'admin'), '{}');

  assert.deepEqual(missingSessions(dir, ['admin', 'user']), ['user']);
});

describe('login', () => {
  let fixture;
  let browser;
  before(async () => {
    fixture = await startFixture();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
    await fixture.close();
  });

  test('one-step form: saves a storage state holding the session cookie', async () => {
    const statePath = await testerSignsIn(browser, USERS.admin, { baseUrl: fixture.url, role: 'admin', stateDir: stateDir() });

    const { cookies } = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(cookies.some((cookie) => cookie.name === 'sid'));
    assert.equal(path.basename(statePath), 'admin.json');
    assert.equal(fixture.logins.admin, 1);
  });

  test('two-step form: email, Continue, then password', async () => {
    await testerSignsIn(browser, USERS.user, { baseUrl: fixture.url, role: 'user', stateDir: stateDir(), loginPath: '/login2' });

    assert.equal(fixture.logins.user, 1);
  });

  test('a wrong password never counts as signed in, and the password is not echoed', async () => {
    const wrong = { ...USERS.admin, password: 'wrong-fixture-pass' };

    await assert.rejects(
      testerSignsIn(browser, wrong, { baseUrl: fixture.url, role: 'admin', stateDir: stateDir(), timeoutMs: 1500 }),
      (error) => error instanceof LoginError && error.step === 'not-signed-in' && !error.message.includes('wrong-fixture-pass'),
    );
  });

  test('nobody signing in times out without writing a session', async () => {
    const dir = stateDir();

    await assert.rejects(
      login(browser, { baseUrl: fixture.url, role: 'admin', stateDir: dir, timeoutMs: 500 }),
      (error) => error instanceof LoginError && error.step === 'not-signed-in',
    );
    assert.deepEqual(missingSessions(dir, ['admin']), ['admin']);
  });
});
