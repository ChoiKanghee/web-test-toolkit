import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSnapshot } from '../test-runner/lib/history.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate.mjs');
const approved = (at) => `> **Duyệt:** ✅ Đã duyệt — Tester — ${at}`;

function bundle(files) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'webtest-gate-'));
  const dir = path.join(cwd, 'artifacts', 'app.test');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return { cwd, dir };
}

function runGate(cwd, args = ['https://app.test']) {
  const env = { ...process.env };
  delete env.WEBTEST_HOST;
  delete env.BASE_URL;
  return new Promise((resolve) => {
    execFile(process.execPath, [GATE, ...args], { cwd, env },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('a new site starts at step 1', async () => {
  const { cwd } = bundle({});
  const { code, stdout } = await runGate(cwd);
  assert.equal(code, 0);
  assert.match(stdout, /^Cổng duyệt — app\.test$/m);
  assert.match(stdout, /G1 requirements\.md\s+— chưa có/);
  assert.match(stdout, /Bước tiếp: bước 1 — requirement-analyst viết requirements\.md\./);
});

test('an approved G1 and a pending plan ask the tester to review the plan', async () => {
  const { cwd } = bundle({ 'requirements.md': `# R\n${approved('2026-09-28 10:05')}\n`, 'test-plan.md': '# P\n> **Duyệt:** ⬜ Chờ duyệt\n' });
  const { stdout } = await runGate(cwd);
  assert.match(stdout, /G1 requirements\.md\s+✅ Tester · 2026-09-28 10:05/);
  assert.match(stdout, /G2 test-plan\.md\s+⬜ chờ duyệt/);
  assert.match(stdout, /Bước tiếp: Tester review và duyệt test-plan\.md\./);
});

test('failed TCs without a heal proposal send the next step to self-healer', async () => {
  const { cwd, dir } = bundle({
    'requirements.md': `# R\n${approved('2026-09-28 08:00')}\n`,
    'test-plan.md': `# P\n${approved('2026-09-28 08:30')}\n`,
    'quality-gate.md': '# Q\n> **Duyệt:** ⬜ Chờ duyệt\n',
  });
  writeSnapshot(dir, {
    runId: '2026-09-28T09-00-00Z', startedAt: '2026-09-28T09:00:00.000Z', decision: 'FAIL',
    cases: [{ tc: 'TC-004', prio: 'P0', tool: 'PW', status: 'failed' }],
  });
  const { stdout } = await runGate(cwd);
  assert.match(stdout, /G3 quality-gate\.md\s+⬜ chờ duyệt · 1 TC fail chưa phân loại/);
  assert.match(stdout, /Bước tiếp: chạy self-healer cho TC-004\./);
});

test('without a URL it prints usage and exits 2', async () => {
  const { cwd } = bundle({});
  const { code, stderr } = await runGate(cwd, []);
  assert.equal(code, 2);
  assert.match(stderr, /Usage/);
});
