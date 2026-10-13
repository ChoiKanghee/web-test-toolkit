import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PENDING_LINE, gateStatus } from '../web-test/lib/approval.mjs';
import { writeSnapshot } from './lib/history.mjs';

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report.mjs');
const RUN_START = new Date('2026-09-27T09:00:00Z');
const RUN_ID = '2026-09-27T09-00-00Z';
const BEFORE = new Date('2026-09-26T08:00:00Z');
const AFTER = new Date('2026-09-27T09:30:00Z');

const spec = (title, status) => ({
  title, ok: status !== 'failed', line: 1,
  tests: [{ results: [{ status, duration: 10 }] }],
});

const REQUIREMENTS = `# Phân tích requirement — app.test
> **Duyệt:** ✅ Đã duyệt — Tester — 2026-09-27 08:00

## Requirement
| REQ | Nhóm | Mô tả | Nguồn | Trạng thái | Xác nhận bởi |
|---|---|---|---|---|---|
| REQ-001 | Đăng nhập | Đăng nhập đúng thì vào | PRD | Đã xác nhận | PRD |
| REQ-002 | Chung | Có header bảo mật | Chuẩn chung | Đã xác nhận | QA |
| REQ-003 | Live | Bắt đầu live | Suy luận | Chấp nhận tạm | — |
| REQ-004 | Phí | Phí ship | Suy luận | Cần hỏi | — |
`;

const APPROVED_PLAN_LINE = '> **Duyệt:** ✅ Đã duyệt — Tester — 2026-09-27 08:30';
const PLAN = `# Test plan — app.test
${APPROVED_PLAN_LINE}

> Status: ⬜ chưa chạy · ✅ pass · ❌ fail · ⏭️ skip

| TC | REQ | P | Tool | Mô tả | Các bước | Kỳ vọng | Status |
|------|----|----|------|----|----|----|--------|
| TC-001 | REQ-001 | P0 | PW | Login | 1. Mở /login | Vào | ✅ |
| TC-002 | REQ-002 | P2 | PW | Header | 1. GET / | Có header | ✅ |
| TC-003 | REQ-003 | P1 | MCP | Live | 1. Start | Chạy | ❌ |
| TC-004 | — | P3 | PW | Mới thêm | 1. Mở / | Có | ✅ |
`;

/** A bundle with a Playwright run that started at RUN_START, and MCP results written at `mcpTime`. */
function bundle({ mcpTime = AFTER, plan = PLAN, heal = null, snapshots = [] } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'webtest-report-'));
  const dir = path.join(cwd, 'artifacts', 'app.test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'requirements.md'), REQUIREMENTS);
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify({
    stats: { startTime: RUN_START.toISOString() },
    suites: [{ file: 'a.spec.mjs', specs: [spec('TC-001 [P0] login', 'passed'), spec('TC-002 [P2] headers', 'failed')] }],
  }));
  const mcp = path.join(dir, 'mcp-results.json');
  writeFileSync(mcp, JSON.stringify([{ tc: 'TC-003', prio: 'P1', status: 'passed', title: 'Live' }]));
  utimesSync(mcp, mcpTime, mcpTime);
  if (plan) writeFileSync(path.join(dir, 'test-plan.md'), plan);
  if (heal) {
    const file = path.join(dir, 'heal-proposal.md');
    writeFileSync(file, '# old proposal\n');
    utimesSync(file, heal, heal);
  }
  for (const snapshot of snapshots) writeSnapshot(dir, snapshot);
  return { cwd, dir };
}

function runReport(cwd) {
  const env = { ...process.env };
  delete env.BASE_URL;
  delete env.WEBTEST_HOST;
  return new Promise((resolve) => {
    execFile(process.execPath, [REPORT, 'app.test'], { cwd, env },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

const gateMd = (dir) => readFileSync(path.join(dir, 'quality-gate.md'), 'utf8');

test('exits 3 without an approved test plan, and writes nothing', async () => {
  for (const plan of [null, PLAN.replace(APPROVED_PLAN_LINE, PENDING_LINE)]) {
    const { cwd, dir } = bundle({ plan });
    const { code, stderr } = await runReport(cwd);
    assert.equal(code, 3);
    assert.match(stderr, /^G2 chưa qua/);
    assert.equal(existsSync(path.join(dir, 'quality-gate.md')), false);
    assert.equal(existsSync(path.join(dir, 'runs')), false);
  }
});

test('MCP results written after the Playwright run count as results', async () => {
  const { cwd, dir } = bundle({ mcpTime: AFTER });
  const { stdout } = await runReport(cwd);
  assert.match(stdout, /2\/3 pass \(1 fail, 0 skip\)/);
  assert.ok(!gateMd(dir).includes('cũ hơn lần chạy này'));
});

test('MCP results older than the Playwright run are treated as not verified', async () => {
  const { cwd, dir } = bundle({ mcpTime: BEFORE });
  const { stdout } = await runReport(cwd);
  assert.match(stdout, /1\/3 pass \(1 fail, 1 skip\)/);
  assert.match(stdout, /mcp-results\.json cũ hơn lần chạy này/);
  assert.match(gateMd(dir), /TC-003 \[P1\] \(MCP\)[^\n]*\n\s+- .*cũ hơn lần chạy này/);
});

test('the quality gate waits for G3, tells the tester what to check, and keeps the CI YAML', async () => {
  const { cwd, dir } = bundle();
  await runReport(cwd);
  const md = gateMd(dir);
  assert.ok(md.startsWith(`# Quality gate — CONCERNS ⚠️ — app.test\n${PENDING_LINE}\n`));
  assert.match(md, /> \*\*Việc của bạn trước khi duyệt \(G3\)\*\*\n> - Mọi TC fail \(1\) phải được self-healer phân loại/);
  const order = ['## Quyết định', '## So với lần chạy trước', '## Fail', '## Chưa kiểm chứng', '## Độ phủ requirement', '## Tóm tắt theo priority', '## Truy vết TC → kết quả', '## Phụ lục'];
  const positions = order.map((heading) => md.indexOf(heading));
  assert.ok(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])), `section order: ${positions}`);
  assert.match(md, /quality_gate:\n {2}host: app\.test\n {2}run_id: 2026-09-27T09-00-00Z\n {2}decision: CONCERNS/);
  assert.match(md, /requirements: \{ confirmed_passed: 1, confirmed_total: 2, provisional_passed: 1, provisional_total: 1, questions: 1 \}/);
  assert.match(md, /\| TC-002 \| a\.spec\.mjs:1 \|/, 'spec locations moved to the appendix');
});

test('requirement coverage is reported per group', async () => {
  const { cwd, dir } = bundle();
  const { stdout } = await runReport(cwd);
  const md = gateMd(dir);
  assert.ok(md.includes('Đã xác nhận: 1/2 đạt · Chấp nhận tạm: 1/1 giữ nguyên · Chờ trả lời: 1'));
  assert.ok(md.includes('| REQ-002 | Có header bảo mật | TC-002 | Không đạt |'));
  assert.ok(md.includes('| REQ-003 | Bắt đầu live | TC-003 | Đạt |'));
  assert.ok(md.includes('| REQ-004 | Phí ship | — | Không có TC |'));
  assert.ok(md.includes('Mốc hồi quy'));
  assert.match(stdout, /Requirement: đã xác nhận 1\/2 đạt · chấp nhận tạm 1\/1 · chờ trả lời 1/);
});

test('each run leaves one snapshot; reporting the same run again overwrites it', async () => {
  const { cwd, dir } = bundle();
  await runReport(cwd);
  await runReport(cwd);
  assert.deepEqual(readdirSync(path.join(dir, 'runs')), [`${RUN_ID}.json`]);
  const snapshot = JSON.parse(readFileSync(path.join(dir, 'runs', `${RUN_ID}.json`), 'utf8'));
  assert.equal(snapshot.decision, 'CONCERNS');
  assert.deepEqual(snapshot.cases.map((c) => [c.tc, c.status]), [['TC-001', 'passed'], ['TC-002', 'failed'], ['TC-003', 'passed']]);
  assert.ok(gateMd(dir).includes('Chưa có lần chạy trước để so sánh.'), 'the run is not compared with itself');
});

test('the report compares this run with the previous one', async () => {
  const previous = {
    runId: '2026-09-26T08-00-00Z', startedAt: '2026-09-26T08:00:00.000Z', decision: 'FAIL',
    cases: [
      { tc: 'TC-001', prio: 'P0', tool: 'PW', status: 'failed' },
      { tc: 'TC-002', prio: 'P2', tool: 'PW', status: 'passed' },
      { tc: 'TC-005', prio: 'P2', tool: 'PW', status: 'passed' },
    ],
  };
  const { cwd, dir } = bundle({ snapshots: [previous] });
  const { stdout } = await runReport(cwd);
  const md = gateMd(dir);
  assert.ok(md.includes('So với lần chạy `2026-09-26T08-00-00Z` (FAIL).'));
  assert.ok(md.includes('| Mới fail | 1 | TC-002 |'));
  assert.ok(md.includes('| Hết fail | 1 | TC-001 |'));
  assert.ok(md.includes('| TC mới | 1 | TC-003 |'));
  assert.ok(md.includes('| TC không còn chạy | 1 | TC-005 |'));
  assert.ok(md.includes('| TC-001 | ❌ ✅ |'));
  assert.match(md, /> - Xem trước 1 TC mới fail: TC-002\./);
  assert.match(stdout, /So với 2026-09-26T08-00-00Z: 1 mới fail, 1 hết fail, 0 vẫn fail/);
});

test('a broken snapshot is skipped with a warning', async () => {
  const { cwd, dir } = bundle();
  mkdirSync(path.join(dir, 'runs'));
  writeFileSync(path.join(dir, 'runs', '2026-09-20T00-00-00Z.json'), '{ broken');
  const { code, stdout } = await runReport(cwd);
  assert.equal(code, 0);
  assert.match(stdout, /Bỏ qua snapshot hỏng: runs\/2026-09-20T00-00-00Z\.json/);
  assert.ok(gateMd(dir).includes('Bỏ qua snapshot hỏng'));
});

test('the plan Status column is rewritten from this run; unrun cases go back to ⬜; G2 stays approved', async () => {
  const { cwd, dir } = bundle();
  await runReport(cwd);
  const plan = readFileSync(path.join(dir, 'test-plan.md'), 'utf8');
  const status = (tc) => new RegExp(`^\\| ${tc} \\|.*\\| (\\S+) \\|$`, 'm').exec(plan)?.[1];
  assert.deepEqual(['TC-001', 'TC-002', 'TC-003', 'TC-004'].map(status), ['✅', '❌', '✅', '⬜']);
  assert.ok(plan.includes('> Status: ⬜ chưa chạy · ✅ pass · ❌ fail · ⏭️ skip'), 'the legend line is left alone');
  assert.ok(plan.includes('| TC-002 | REQ-002 | P2 | PW | Header | 1. GET / | Có header |'), 'other cells are left alone');
  assert.equal(gateStatus(dir)[1].state, 'approved');
});

test('a stale MCP result shows as ⏭️ in the plan', async () => {
  const { cwd, dir } = bundle({ mcpTime: BEFORE });
  await runReport(cwd);
  assert.match(readFileSync(path.join(dir, 'test-plan.md'), 'utf8'), /^\| TC-003 \|.*\| ⏭️ \|$/m);
});

test('CRLF plans keep their line endings', async () => {
  const { cwd, dir } = bundle({ plan: PLAN.replaceAll('\n', '\r\n') });
  await runReport(cwd);
  const plan = readFileSync(path.join(dir, 'test-plan.md'), 'utf8');
  assert.match(plan, /^\| TC-002 \|.*\| ❌ \|\r$/m);
  assert.equal(plan.split('\r\n').length, PLAN.split('\n').length);
});

test('a heal proposal from before this run is archived under its date', async () => {
  const { cwd, dir } = bundle({ heal: BEFORE });
  await runReport(cwd);
  assert.equal(existsSync(path.join(dir, 'heal-proposal.md')), false);
  const archived = readdirSync(dir).filter((f) => /^heal-proposal\.\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(f));
  assert.equal(archived.length, 1);
  assert.equal(readFileSync(path.join(dir, archived[0]), 'utf8'), '# old proposal\n');
});

test('a heal proposal written after this run is kept', async () => {
  const { cwd, dir } = bundle({ heal: AFTER });
  await runReport(cwd);
  assert.equal(existsSync(path.join(dir, 'heal-proposal.md')), true);
});
