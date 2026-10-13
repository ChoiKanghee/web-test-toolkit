import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { FILE_BYTES, startFixture } from '../test-fixtures/app.mjs';
import { capturePage, probeFile, renderExploration } from './capture.mjs';
import { isUnsafe } from './url-template.mjs';

describe('capturePage', () => {
  let fixture;
  let browser;
  before(async () => {
    fixture = await startFixture({ requireAuth: false });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
    await fixture.close();
  });

  test('collects status, outline, skeleton, console errors and every link', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());

    const result = await capturePage(page, `${fixture.url}/public`);

    assert.equal(result.status, 200);
    assert.equal(result.isFile, false);
    assert.equal(result.title, 'Fixture public');
    assert.deepEqual(result.skeleton, { fields: 1, buttons: 2, landmarks: ['banner', 'form', 'main', 'navigation'] });
    assert.ok(result.consoleMsgs.some((m) => m.type === 'error' && m.text === 'fixture-error'));
    assert.ok(result.hrefs.includes(`${fixture.url}/hidden-menu`), 'hidden links are still collected');
  });

  test("'settled' returns on a long-poll page without a navigation error (Review Focus)", async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const started = Date.now();

    const result = await capturePage(page, `${fixture.url}/long-poll`, { waitStrategy: 'settled' });

    assert.equal(result.status, 200);
    assert.ok(Date.now() - started < 15_000, 'did not wait for a network that never settles');
    assert.ok(!result.consoleMsgs.some((m) => m.type === 'nav-error'));
  });

  test('an attachment is reported as a file and its download is cancelled', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());

    const result = await capturePage(page, `${fixture.url}/files/get?id=3`, { waitStrategy: 'settled' });

    assert.equal(result.isFile, true);
    assert.equal(result.hrefs, undefined);
    const ended = await fixture.streamEnded('/files/get');
    assert.notEqual(ended?.completed, true);
  });

  test('renderExploration keeps the exploration.md shape', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const result = await capturePage(page, `${fixture.url}/public`);

    const md = renderExploration(result, 'fixture.test');

    assert.ok(md.startsWith('# Exploration report — fixture.test\n'));
    assert.ok(md.includes('- **HTTP status:** 200'));
    assert.ok(md.includes('### Fields (1)'));
    assert.ok(md.includes('- `error` fixture-error'));
  });
});

describe('probeFile', () => {
  let fixture;
  let guarded;
  let browser;
  let context;
  before(async () => {
    fixture = await startFixture({ requireAuth: false });
    guarded = await startFixture({ requireAuth: true });
    browser = await chromium.launch();
    context = await browser.newContext();
  });
  after(async () => {
    await browser.close();
    await fixture.close();
    await guarded.close();
  });

  test('HEAD reads status, type and size without opening a body', async () => {
    const result = await probeFile(context, `${fixture.url}/docs/manual.pdf`);

    assert.deepEqual(
      { outcome: result.outcome, status: result.status, method: result.method, bytes: result.bytes },
      { outcome: 'ok', status: 200, method: 'head', bytes: FILE_BYTES },
    );
    assert.equal(result.contentType, 'application/pdf');
    assert.equal(await fixture.streamEnded('/docs/manual.pdf'), null);
  });

  test('HEAD refused: falls back to a ranged GET and drops the body even when Range is ignored', async () => {
    const result = await probeFile(context, `${fixture.url}/legacy/report.pdf`);

    assert.equal(result.method, 'range');
    assert.equal(result.status, 200);
    assert.equal(result.bytes, FILE_BYTES);
    const ended = await fixture.streamEnded('/legacy/report.pdf');
    assert.equal(ended.completed, false, 'the 5 MB body was never read to the end');
  });

  test('a server that never answers is given up on after timeoutMs', { timeout: 10_000 }, async () => {
    const started = Date.now();
    await assert.rejects(probeFile(context, `${fixture.url}/never-ends`, { timeoutMs: 1000 }), /timeout|abort/i);
    assert.ok(Date.now() - started < 5000);
  });

  test('a missing file reports its 404', async () => {
    const result = await probeFile(context, `${fixture.url}/docs/missing.pdf`);
    assert.equal(result.status, 404);
  });

  test('a redirect to the login page is reported, not followed', async () => {
    const result = await probeFile(context, `${guarded.url}/docs/manual.pdf`, { loginPath: '/login' });
    assert.equal(result.outcome, 'login-redirect');
    assert.equal(guarded.called('/login'), false);
  });

  test('a redirect to an unsafe URL is not followed', async () => {
    const result = await probeFile(context, `${fixture.url}/go-export`, { canFollow: (url) => !isUnsafe(url) });
    assert.equal(result.outcome, 'blocked-redirect');
    assert.equal(fixture.called('/reports/export.csv'), false);
  });
});
