import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startFixture } from './test-fixtures/app.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'test-fixtures', 'explore.golden.md');

test('explore.mjs writes the same exploration.md as before (golden)', async (t) => {
  const fixture = await startFixture({ requireAuth: false });
  t.after(fixture.close);
  const cwd = mkdtempSync(path.join(tmpdir(), 'webtest-explore-'));
  const env = { ...process.env };
  delete env.WEBTEST_HOST;

  await run(process.execPath, [path.join(here, 'explore.mjs'), `${fixture.url}/public`], { cwd, env });

  const host = new URL(fixture.url).host.replace(/[^a-z0-9.-]/gi, '_');
  const actual = readFileSync(path.join(cwd, 'artifacts', host, 'exploration.md'), 'utf8')
    .replaceAll(fixture.url, 'http://FIXTURE')
    .replaceAll(host, 'FIXTURE_HOST');
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, actual);
  assert.equal(actual, readFileSync(GOLDEN, 'utf8').replaceAll('\r\n', '\n'));
});
