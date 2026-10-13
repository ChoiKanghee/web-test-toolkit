import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUGS = path.join(HERE, 'bugs.mjs');
const FIXTURE = readFileSync(path.join(HERE, 'test-fixtures', 'bug-report.md'), 'utf8').replace(/\r\n/g, '\n');
const approved = (at) => `> **Duyệt:** ✅ Đã duyệt — Tester — ${at}`;

function bundle(report = FIXTURE) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'webtest-bugs-'));
  const dir = path.join(cwd, 'artifacts', 'app.test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'requirements.md'), `# R\n${approved('2026-09-28 08:00')}\n`);
  writeFileSync(path.join(dir, 'test-plan.md'), `# P\n${approved('2026-09-28 08:30')}\n`);
  writeFileSync(path.join(dir, 'quality-gate.md'), `# Q\n${approved('2026-09-28 10:00')}\n`);
  writeFileSync(path.join(dir, 'bug-report.md'), report);
  return { cwd, dir };
}

function runBugs(cwd) {
  const env = { ...process.env };
  delete env.WEBTEST_HOST;
  delete env.BASE_URL;
  return new Promise((resolve) => {
    execFile(process.execPath, [BUGS, 'https://app.test'], { cwd, env },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('exits 3 while the bug report is not approved', async () => {
  const { cwd, dir } = bundle(FIXTURE.replace(approved('2026-09-28 16:00'), '> **Duyệt:** ⬜ Chờ duyệt'));
  const { code, stderr } = await runBugs(cwd);
  assert.equal(code, 3);
  assert.match(stderr, /G4 chưa qua: bug-report\.md chờ duyệt/);
  assert.equal(existsSync(path.join(dir, 'bugs.csv')), false);
});

test('exits 1 and names the bug when a required field is missing', async () => {
  const { cwd, dir } = bundle(FIXTURE.replace('**Thực tế:** Nút Lưu tràn ra ngoài\n', ''));
  const { code, stderr } = await runBugs(cwd);
  assert.equal(code, 1);
  assert.match(stderr, /BUG-002: thiếu Thực tế/);
  assert.equal(existsSync(path.join(dir, 'bugs.csv')), false);
});

test('writes bugs.csv with the bugs still to import', async () => {
  const { cwd, dir } = bundle();
  const { code, stdout } = await runBugs(cwd);
  assert.equal(code, 0);
  assert.match(stdout, /Đã xuất 1 bug → .*bugs\.csv \(bỏ qua 2: đã có Jira key hoặc Đã sửa\)/);
  const csv = readFileSync(path.join(dir, 'bugs.csv'), 'utf8');
  assert.match(csv, /^Summary,/);
  assert.ok(csv.includes('BUG-001: '));
  assert.ok(!csv.includes('BUG-002') && !csv.includes('BUG-003'));
});

test('writes nothing when every bug is already imported or fixed', async () => {
  const { cwd, dir } = bundle(FIXTURE.replace('- **Jira:**\n\n**Điều kiện trước:**', '- **Jira:** APP-1\n\n**Điều kiện trước:**'));
  const { code, stdout } = await runBugs(cwd);
  assert.equal(code, 0);
  assert.match(stdout, /Không có bug nào cần xuất/);
  assert.equal(existsSync(path.join(dir, 'bugs.csv')), false);
});
