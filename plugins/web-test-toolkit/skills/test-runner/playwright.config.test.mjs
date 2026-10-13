import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'playwright.config.mjs');
const approved = (at) => `> **Duyệt:** ✅ Đã duyệt — Tester — ${at}`;

function loadConfig(files) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'webtest-config-'));
  const dir = path.join(cwd, 'artifacts', 'app.test');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  const env = { ...process.env, BASE_URL: 'https://app.test' };
  delete env.WEBTEST_HOST;
  const code = `await import(${JSON.stringify(pathToFileURL(CONFIG).href)}); console.log(process.env.WEBTEST_AUTH_DIR);`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { cwd, env },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, cwd }));
  });
}

test('loading the config fails while the test plan is not approved', async () => {
  const { code, stderr } = await loadConfig({
    'requirements.md': `# R\n${approved('2026-09-28 10:00')}\n`,
    'test-plan.md': '# P\n> **Duyệt:** ⬜ Chờ duyệt\n',
  });
  assert.equal(code, 3, 'blocked by a gate, not failed');
  assert.match(stderr, /G2 chưa qua: test-plan\.md chờ duyệt/);
  assert.doesNotMatch(stderr, /\n\s+at /, 'no stack trace for the tester');
});

test('the config loads once G1 and G2 are approved in order', async () => {
  const { code, stderr } = await loadConfig({
    'requirements.md': `# R\n${approved('2026-09-28 10:00')}\n`,
    'test-plan.md': `# P\n${approved('2026-09-28 11:00')}\n`,
  });
  assert.equal(code, 0, stderr);
});
