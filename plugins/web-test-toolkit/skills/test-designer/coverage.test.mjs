import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COVERAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'coverage.mjs');

const outline = (url, buttons) => `# Exploration report — app.test

- **Final URL:** ${url}

### Fields (0)
_none_

### Buttons (${buttons.length})
${buttons.map((b) => `- ${b}`).join('\n')}

### Links (0)
_none_
`;

const approved = (at) => `> **Duyệt:** ✅ Đã duyệt — Tester — ${at}`;
const REQUIREMENTS = `# Phân tích requirement — app.test
${approved('2026-09-28 10:00')}

## Requirement
| REQ | Nhóm | Mô tả | Nguồn | Trạng thái | Xác nhận bởi |
|---|---|---|---|---|---|
| REQ-001 | Đăng nhập | Đăng nhập được | Suy luận | Chấp nhận tạm | — |
`;

const planWith = (rows, notTested = '') => `# Test plan

## Route không test (và lý do)
${notTested}

## Test cases
| TC | REQ | P | Tool | Mô tả | Các bước | Kỳ vọng | Status |
|---|---|---|---|---|---|---|---|
${rows}
`;

function bundle({ requirements = REQUIREMENTS } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'webtest-coverage-'));
  const dir = path.join(cwd, 'artifacts', 'app.test');
  mkdirSync(path.join(dir, 'crawl', 'pages', 'orders-1'), { recursive: true });
  if (requirements) writeFileSync(path.join(dir, 'requirements.md'), requirements);
  writeFileSync(path.join(dir, 'exploration.md'), outline('https://app.test/login', ['Log in']));
  writeFileSync(path.join(dir, 'crawl', 'pages', 'orders-1', 'exploration.md'), outline('https://app.test/orders', ['Export']));
  writeFileSync(path.join(dir, 'crawl', 'site-map.json'), JSON.stringify({
    templates: [
      { template: '/orders', kind: 'page', evidence: 'pages/orders-1/exploration.md' },
      { template: '/admin', kind: 'page', evidence: null },
    ],
    bundleRoutes: { routes: [{ route: '/settings' }, { route: '/orders' }] },
  }));
  return { cwd, dir };
}

function runCoverage(cwd) {
  const env = { ...process.env };
  delete env.WEBTEST_HOST;
  return new Promise((resolve) => {
    execFile(process.execPath, [COVERAGE, 'https://app.test'], { cwd, env },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('exits 1 and writes coverage.md listing what the plan misses', async () => {
  const { cwd, dir } = bundle();
  writeFileSync(path.join(dir, 'test-plan.md'), planWith('| TC-001 | REQ-001 | P0 | PW | Login | 1. Mở /login; 2. Bấm "Log in" | Vào | ⬜ |'));

  const { code, stdout } = await runCoverage(cwd);

  assert.equal(code, 1);
  const md = readFileSync(path.join(dir, 'coverage.md'), 'utf8');
  const gaps = md.slice(md.indexOf('## Gaps'), md.indexOf('## Routes'));
  for (const item of ['/orders', '/admin', '/settings', 'Export']) assert.ok(gaps.includes(`| ${item} |`), item);
  assert.ok(!gaps.includes('/login'), 'the explored start page counts as a route and is covered');
  assert.match(stdout, /4 gap\(s\)/);
});

test('exits 0 when every route and control is covered or listed as not tested', async () => {
  const { cwd, dir } = bundle();
  writeFileSync(path.join(dir, 'test-plan.md'), planWith(
    ['| TC-001 | REQ-001 | P0 | PW | Login | 1. Mở /login; 2. Bấm "Log in" | Vào | ⬜ |',
      '| TC-002 | — | P1 | PW | Orders | 1. Mở /orders; 2. Bấm "Export" | Tải file | ⬜ |',
      '| TC-003 | — | P0 | PW | Admin | 1. Mở /admin | Bị chặn | ⬜ |'].join('\n'),
    '| `/settings` | cần tài khoản admin |',
  ));

  const { code, stdout } = await runCoverage(cwd);

  assert.equal(code, 0);
  assert.match(stdout, /0 gap\(s\)/);
});

test('exits 3 while requirements.md is not approved', async () => {
  const { cwd, dir } = bundle({ requirements: REQUIREMENTS.replace(approved('2026-09-28 10:00'), '> **Duyệt:** ⬜ Chờ duyệt') });
  writeFileSync(path.join(dir, 'test-plan.md'), planWith('| TC-001 | REQ-001 | P0 | PW | Login | 1. Mở /login | Vào | ⬜ |'));
  const { code, stderr } = await runCoverage(cwd);
  assert.equal(code, 3);
  assert.match(stderr, /G1 chưa qua: requirements\.md chờ duyệt/);
  assert.equal(existsSync(path.join(dir, 'coverage.md')), false);
});

test('exits 1 when requirements.md has no readable requirement table', async () => {
  const { cwd, dir } = bundle({ requirements: `# R\n${approved('2026-09-28 10:00')}\n\nChưa có bảng.\n` });
  writeFileSync(path.join(dir, 'test-plan.md'), planWith('| TC-001 | — | P0 | PW | Login | 1. Mở /login | Vào | ⬜ |'));
  const { code, stderr } = await runCoverage(cwd);
  assert.equal(code, 1);
  assert.match(stderr, /không có bảng Requirement/);
});

test('a requirement with no TC is a gap', async () => {
  const { cwd, dir } = bundle();
  writeFileSync(path.join(dir, 'test-plan.md'), planWith(
    ['| TC-001 | — | P0 | PW | Login | 1. Mở /login; 2. Bấm "Log in" | Vào | ⬜ |',
      '| TC-002 | — | P1 | PW | Orders | 1. Mở /orders; 2. Bấm "Export" | Tải file | ⬜ |',
      '| TC-003 | — | P0 | PW | Admin | 1. Mở /admin | Bị chặn | ⬜ |'].join('\n'),
    '| `/settings` | cần tài khoản admin |',
  ));
  const { code, stdout } = await runCoverage(cwd);
  assert.equal(code, 1);
  assert.match(stdout, /requirement "REQ-001 Đăng nhập được"/);
  assert.match(stdout, /requirements 0\/1/);
});

test('exits 2 without a test plan', async () => {
  const { cwd, dir } = bundle();
  const { code, stderr } = await runCoverage(cwd);
  assert.equal(code, 2);
  assert.match(stderr, /test-plan\.md/);
  assert.equal(existsSync(path.join(dir, 'coverage.md')), false);
});
