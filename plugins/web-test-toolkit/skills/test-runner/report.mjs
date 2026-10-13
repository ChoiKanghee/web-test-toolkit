#!/usr/bin/env node
// report.mjs — merge Playwright + chrome-devtools-MCP results into the quality gate the tester
// reviews at gate G3: the decision (PASS / CONCERNS / BLOCKED / FAIL), what changed since the
// last run, requirement coverage and a TC → result table. Written in Vietnamese for the tester;
// the CI YAML at the end keeps English keys.
//
// Host (per-domain bundle) is derived from BASE_URL, or passed as argv[2].
// Requires gate G2 (test-plan.md approved no earlier than requirements.md) — exit 3 otherwise.
// Reads (whichever exist):
//   artifacts/<host>/results.json       (Playwright `json` reporter — Tool=PW cases)
//   artifacts/<host>/mcp-results.json    (agent-written — Tool=MCP cases)
//     shape: [{ tc, prio, status:'passed'|'failed'|'skipped', title, durationMs?, note? }]
//       status 'skipped' = the case could NOT be verified (tool/environment limit, or a
//         missing precondition). It is neither a pass nor a fail, and is excluded from
//         every pass-rate denominator.
//       note (optional string) = why it was skipped, or evidence behind a verdict. A
//         skipped record should always carry one; it is printed in the gate report.
//   artifacts/<host>/requirements.md, test-plan.md (REQ ↔ TC links), runs/*.json (history)
// Writes:
//   artifacts/<host>/quality-gate.md     (approval line reset to "Chờ duyệt" on every run)
//   artifacts/<host>/runs/<runId>.json   (this run; reporting the same run again overwrites it)
//   artifacts/<host>/test-plan.md        (Status column only: ✅ / ❌ / ⏭️, ⬜ = not in this run)
//
// Stale inputs: MCP results written before the Playwright run started belong to an older
// run, so they count as skipped (not verified) with a note. A heal-proposal.md written
// before the run started is renamed heal-proposal.<date>-<time>.md.
//
// Priority from a [P0]..[P3] tag in the title (or the `prio` field for MCP);
// TC id from a TC-\d+ token (or the `tc` field). Gate thresholds (BMAD):
//   P0 pass rate must be 100% → FAIL otherwise; P1 ≥95% → CONCERNS otherwise;
//   P2/P3 failures informational. A P0 case that was skipped (unverified, not broken)
//   yields BLOCKED, not FAIL. Exit code: FAIL → 1, BLOCKED → 2, G2 not passed → 3, otherwise 0.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PENDING_LINE, requireGatesOrExit } from '../web-test/lib/approval.mjs';
import { parseRequirements, planRequirements } from '../web-test/lib/requirements.mjs';
import {
  compareRuns, historyStrip, previousSnapshot, readSnapshots, runIdOf, snapshotCases, writeSnapshot,
} from './lib/history.mjs';
import { REQ_RESULT, reqCoverage, reqGroup, reqSummary } from './lib/req-coverage.mjs';

const base = process.env.BASE_URL;
// Sanitize identically to test-designer/lib/bundle.mjs so ported hosts (localhost:3000)
// resolve to the same artifacts/<host>/ folder the other phases use.
const rawHost = process.argv[2] || process.env.WEBTEST_HOST || (base ? new URL(base).host : '');
const host = (rawHost || '').replace(/[^a-z0-9.-]/gi, '_');
if (!host) {
  console.error('Thiếu host. Đặt BASE_URL=<url> (hoặc truyền host làm tham số đầu) để biết đọc artifacts/<host>/ nào.');
  process.exit(1);
}
const dir = path.join('artifacts', host);
requireGatesOrExit(dir, 'G2');

const pwPath = path.join(dir, 'results.json');
const mcpPath = path.join(dir, 'mcp-results.json');
const OUT = path.join(dir, 'quality-gate.md');
const planPath = path.join(dir, 'test-plan.md');
const reqPath = path.join(dir, 'requirements.md');
const healPath = path.join(dir, 'heal-proposal.md');

const prioOf = (t) => t.match(/\[(P[0-3])\]/)?.[1] || 'P1';
const tcOf = (t) => t.match(/\b(TC-\d+)\b/)?.[1] || '—';
const cleanTitle = (t) => t.replace(/\[P[0-3]\]\s*/, '').replace(/^TC-\d+\s*/, '');

const rows = [];
let runStart = null; // when the Playwright run began; anything written before it is stale

// ---- Playwright results ----
if (existsSync(pwPath)) {
  const data = JSON.parse(readFileSync(pwPath, 'utf8'));
  if (data.stats?.startTime) runStart = new Date(data.stats.startTime);
  const walk = (suite, file) => {
    const f = suite.file || file;
    for (const s of suite.specs || []) {
      const result = s.tests?.[0]?.results?.at(-1);
      // test.skip()/test.fixme() leaves spec.ok === true — an unrun case is not a pass.
      const skipped = result?.status === 'skipped';
      rows.push({
        tool: 'PW',
        title: s.title,
        ok: s.ok === true && !skipped,
        skipped,
        note: '',
        duration: result?.duration ?? 0,
        loc: `${(f || '').split('/').pop()}:${s.line ?? ''}`,
        prio: prioOf(s.title),
        tc: tcOf(s.title),
      });
    }
    for (const child of suite.suites || []) walk(child, f);
  };
  for (const suite of data.suites || []) walk(suite);
}

// ---- chrome-devtools-MCP results (agent-written) ----
let staleMcp = 0;
let mcpWritten = null;
if (existsSync(mcpPath)) {
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
  mcpWritten = statSync(mcpPath).mtime;
  const stale = runStart !== null && mcpWritten < runStart;
  for (const r of Array.isArray(mcp) ? mcp : []) {
    const title = r.title || '';
    const skipped = stale || r.status === 'skipped' || r.status === 'skip';
    if (stale) staleMcp += 1;
    rows.push({
      tool: 'MCP',
      title,
      ok: !skipped && (r.status === 'passed' || r.status === 'pass' || r.ok === true),
      skipped,
      note: stale
        ? `mcp-results.json cũ hơn lần chạy này (ghi lúc ${mcpWritten.toISOString()}, kết quả khi đó: ${r.status}) — chạy lại case này.`
        : r.note || '',
      duration: r.durationMs ?? 0,
      loc: 'chrome-devtools-mcp',
      prio: r.prio || prioOf(title),
      tc: r.tc || tcOf(title),
    });
  }
}

if (!rows.length) {
  console.error(`Không có kết quả trong ${dir} (cần results.json và/hoặc mcp-results.json). Chạy test trước.`);
  process.exit(1);
}

const by = (p) => rows.filter((r) => r.prio === p);
const passN = (arr) => arr.filter((r) => r.ok).length;
const failN = (arr) => arr.filter((r) => !r.ok && !r.skipped).length;
const skipN = (arr) => arr.filter((r) => r.skipped).length;
// Skipped cases leave the denominator entirely: a case we could not verify is evidence
// for nothing. `null` = nothing was actually executed at that priority.
const rate = (arr) => {
  const executed = arr.length - skipN(arr);
  return executed ? Math.round((passN(arr) / executed) * 100) : null;
};
const fmtRate = (arr) => (rate(arr) === null ? '—' : `${rate(arr)}%`);

const P0 = by('P0'), P1 = by('P1'), P2 = by('P2'), P3 = by('P3');
const total = rows.length, passed = passN(rows), failed = failN(rows), skipped = skipN(rows);
const fails = rows.filter((r) => !r.ok && !r.skipped);
const skips = rows.filter((r) => r.skipped);

// ---- Gate decision ----
// FAIL > BLOCKED > CONCERNS > PASS. BLOCKED means "not verified", never "broken".
let decision, icon, rationale;
if (failN(P0)) {
  decision = 'FAIL'; icon = '❌';
  rationale = `${failN(P0)} test P0 (nghiêm trọng) fail. P0 phải đạt 100%. Chặn phát hành cho tới khi sửa.`;
} else if (skipN(P0)) {
  decision = 'BLOCKED'; icon = '⛔';
  rationale = `${skipN(P0)} case P0 không kiểm chứng được — do giới hạn của công cụ hoặc môi trường, không phải lỗi của ứng dụng. Mọi case P0 đã chạy đều pass. Kiểm chứng lại các case này bằng cách khác (thiết bị thật, test tay) trước khi phát hành; đây không phải P0 fail.`;
} else if (rate(P1) !== null && rate(P1) < 95) {
  decision = 'CONCERNS'; icon = '⚠️';
  rationale = `Mọi P0 pass, nhưng tỉ lệ pass P1 là ${rate(P1)}%, dưới ngưỡng 95%. Chỉ phát hành khi có giám sát chặt và kế hoạch khắc phục.`;
} else if (failed > 0) {
  decision = 'CONCERNS'; icon = '⚠️';
  rationale = `Đạt ngưỡng P0/P1, nhưng ${failed} test P2/P3 fail. Chỉ để theo dõi, không chặn.`;
} else if (skipped > 0) {
  decision = 'CONCERNS'; icon = '⚠️';
  rationale = `Mọi test đã chạy đều pass, nhưng ${skipped} case (không phải P0) chưa kiểm chứng được. Độ phủ chưa đủ — kiểm chứng lại bằng cách khác trước khi coi lần chạy là sạch.`;
} else {
  decision = 'PASS'; icon = '✅';
  rationale = `Cả ${total} test pass ở mọi priority. Không có vấn đề chặn.`;
}

// ---- History: this run's snapshot, and how it compares ----
const startedAt = runStart ?? mcpWritten ?? statSync(pwPath).mtime;
const runId = runIdOf(startedAt);
const cases = snapshotCases(rows);
const { snapshots: earlier, warnings: historyWarnings } = readSnapshots(dir);
const snapshot = { runId, startedAt: startedAt.toISOString(), decision, cases };
writeSnapshot(dir, snapshot);
const previous = previousSnapshot(earlier, runId);
const changes = previous ? compareRuns(snapshot, previous) : null;
const strip = historyStrip([...earlier.filter((s) => s.runId < runId), snapshot]);
const unstable = strip.filter((s) => s.unstable);

// ---- Requirements (G2 passed, so both files exist) ----
const planReqs = planRequirements(readFileSync(planPath, 'utf8'));
const requirements = parseRequirements(readFileSync(reqPath, 'utf8'));
const reqResults = reqCoverage(requirements, planReqs, cases);
const reqTotals = reqSummary(reqResults);

// ---- Render ----
const MARK = { passed: '✅', failed: '❌', skipped: '⏭️' };
const cell = (value) => String(value).replaceAll('|', '\\|');
const verdict = (r) => (r.skipped ? '⏭️ chưa kiểm chứng' : r.ok ? '✅ pass' : '❌ FAIL');
const bullet = (r) => `- **${r.tc} [${r.prio}] (${r.tool})** ${cleanTitle(r.title)}${r.note ? `\n  - ${r.note}` : ''}`;
const sorted = [...rows].sort((a, b) => a.prio.localeCompare(b.prio) || a.tc.localeCompare(b.tc, 'en', { numeric: true }));

const todo = [
  changes?.newFail.length && `Xem trước ${changes.newFail.length} TC mới fail: ${changes.newFail.join(', ')}.`,
  failed && `Mọi TC fail (${failed}) phải được self-healer phân loại — bug thật hay lỗi script — trong heal-proposal.md trước khi duyệt.`,
  skipped && `Chấp nhận hoặc không chấp nhận ${skipped} case chưa kiểm chứng được (lý do ở mục "Chưa kiểm chứng").`,
  unstable.length && `${unstable.length} TC không ổn định (${unstable.map((s) => s.tc).join(', ')}): nghĩ tới test flaky trước khi kết luận là bug.`,
].filter(Boolean);
if (!todo.length) todo.push('Không có fail, skip hay thay đổi bất thường: đọc quyết định và độ phủ requirement rồi duyệt.');

const COMPARE = [
  ['newFail', 'Mới fail'], ['fixed', 'Hết fail'], ['stillFail', 'Vẫn fail'],
  ['newSkip', 'Mới không kiểm chứng được'], ['added', 'TC mới'], ['removed', 'TC không còn chạy'],
];
const compareSection = [
  previous
    ? [`So với lần chạy \`${previous.runId}\` (${previous.decision}).`, '',
      '| Nhóm | Số TC | TC |', '|---|---|---|',
      ...COMPARE.map(([key, label]) => `| ${label} | ${changes[key].length} | ${changes[key].join(', ') || '—'} |`)].join('\n')
    : '_Chưa có lần chạy trước để so sánh._',
  strip.length
    ? ['TC từng đổi kết quả trong 5 lần chạy gần nhất (cũ → mới, `·` = không chạy):', '',
      '| TC | Lịch sử | Ghi chú |', '|---|---|---|',
      ...strip.map((s) => `| ${s.tc} | ${s.statuses.map((st) => MARK[st] ?? '·').join(' ')} | ${s.unstable ? 'không ổn định' : ''} |`)].join('\n')
    : '',
  ...historyWarnings.map((w) => `> Bỏ qua snapshot hỏng: ${w}`),
].filter(Boolean).join('\n\n');

const failSection = fails.length ? fails.map(bullet).join('\n') : '_Không có fail._';
const skipSection = skips.length
  ? '_Không tính vào tỉ lệ pass. Đây là câu hỏi còn mở, không phải kết quả — kiểm chứng lại bằng cách khác trước khi coi lần chạy là đầy đủ._\n\n'
    + skips.map(bullet).join('\n')
  : '_Không có case chưa kiểm chứng._';

const REQ_GROUPS = [
  ['confirmed', 'Đã xác nhận', ''],
  ['provisional', 'Chấp nhận tạm', '_Mốc hồi quy: pass nghĩa là trang vẫn như lúc khám phá, chưa chứng minh trang đúng yêu cầu._'],
  ['question', 'Chờ trả lời', '_Chưa có TC cho tới khi PO/BA trả lời câu hỏi trong requirements.md._'],
];
const reqNote = (r) => (r.result === 'unverified' && r.missing.length ? ` (không chạy: ${r.missing.join(', ')})` : '');
const reqSection = !requirements.length
  ? '_Không đọc được bảng Requirement trong requirements.md — bỏ qua mục này._'
  : [
    `Đã xác nhận: ${reqTotals.confirmed_passed}/${reqTotals.confirmed_total} đạt · Chấp nhận tạm: ${reqTotals.provisional_passed}/${reqTotals.provisional_total} giữ nguyên · Chờ trả lời: ${reqTotals.questions}`,
    ...REQ_GROUPS.map(([group, title, note]) => {
      const items = reqResults.filter((r) => reqGroup(r) === group);
      if (!items.length) return '';
      const table = ['| REQ | Mô tả | TC | Kết quả |', '|---|---|---|---|',
        ...items.map((r) => `| ${r.id} | ${cell(r.description)} | ${r.tcs.join(', ') || '—'} | ${REQ_RESULT[r.result]}${reqNote(r)} |`)].join('\n');
      return [`### ${title}`, note, table].filter(Boolean).join('\n\n');
    }),
  ].filter(Boolean).join('\n\n');

const prioRow = (label, arr, threshold, status) =>
  `| ${label} | ${arr.length} | ${passN(arr)} | ${failN(arr)} | ${skipN(arr)} | ${fmtRate(arr)} | ${threshold} | ${status} |`;
const traceRows = sorted
  .map((r) => `| ${r.tc} | ${planReqs.get(r.tc)?.join(', ') || '—'} | ${r.prio} | ${r.tool} | ${verdict(r)} | ${(r.duration / 1000).toFixed(1)}s | ${cell(cleanTitle(r.title))} |`)
  .join('\n');
const locationRows = sorted.map((r) => `| ${r.tc} | ${r.loc} | ${cell(cleanTitle(r.title))} |`).join('\n');

const md = `# Quality gate — ${decision} ${icon} — ${host}
${PENDING_LINE}

> **Việc của bạn trước khi duyệt (G3)**
${todo.map((t) => `> - ${t}`).join('\n')}

## Quyết định: ${decision} ${icon}

${rationale}

Lần chạy \`${runId}\` · ${total} TC · ${passed} pass · ${failed} fail · ${skipped} chưa kiểm chứng

## So với lần chạy trước

${compareSection}

## Fail

${failSection}

## Chưa kiểm chứng (skip)

${skipSection}

## Độ phủ requirement

${reqSection}

## Tóm tắt theo priority

Tỉ lệ pass = pass / (tổng − chưa kiểm chứng). Case chưa kiểm chứng không tính là pass, cũng
không tính là fail.

| Priority | Tổng | Pass | Fail | Chưa kiểm chứng | Tỉ lệ pass | Ngưỡng | Trạng thái |
|---|---|---|---|---|---|---|---|
${prioRow('P0 (nghiêm trọng)', P0, '100%', failN(P0) ? '❌' : skipN(P0) ? '⏭️' : '✅')}
${prioRow('P1 (cao)', P1, '≥95%', rate(P1) !== null && rate(P1) < 95 ? '⚠️' : skipN(P1) ? '⏭️' : '✅')}
${prioRow('P2 (trung bình)', P2, 'tham khảo', failN(P2) ? 'ℹ️' : skipN(P2) ? '⏭️' : '✅')}
${prioRow('P3 (thấp)', P3, 'tham khảo', failN(P3) ? 'ℹ️' : skipN(P3) ? '⏭️' : '✅')}
| **Tổng** | **${total}** | **${passed}** | **${failed}** | **${skipped}** | **${fmtRate(rows)}** | — | ${failed ? '⚠️' : skipped ? '⏭️' : '✅'} |

## Truy vết TC → kết quả

| TC | REQ | Prio | Tool | Kết quả | Thời gian | Mô tả |
|---|---|---|---|---|---|---|
${traceRows}

## Phụ lục

### Vị trí trong spec

| TC | Vị trí | Mô tả |
|---|---|---|
${locationRows}

### Gate cho CI

\`\`\`yaml
quality_gate:
  host: ${host}
  run_id: ${runId}
  decision: ${decision}
  totals: { total: ${total}, passed: ${passed}, failed: ${failed}, skipped: ${skipped} }
  pass_rate: { p0: ${rate(P0) ?? 'null'}, p1: ${rate(P1) ?? 'null'}, p2: ${rate(P2) ?? 'null'}, p3: ${rate(P3) ?? 'null'}, overall: ${rate(rows) ?? 'null'} }
  thresholds: { p0: 100, p1: 95 }
  requirements: { confirmed_passed: ${reqTotals.confirmed_passed}, confirmed_total: ${reqTotals.confirmed_total}, provisional_passed: ${reqTotals.provisional_passed}, provisional_total: ${reqTotals.provisional_total}, questions: ${reqTotals.questions} }
  # pass_rate excludes skipped cases; null = nothing executed at that priority.
\`\`\`
`;

writeFileSync(OUT, md);

// ---- Keep the plan's Status column in step with this run ----
const symbol = new Map(cases.map((c) => [c.tc, MARK[c.status]]));
const plan = readFileSync(planPath, 'utf8');
const nextPlan = plan.replace(/^(\| (TC-\d+) \|.*\| )\S+( \|\r?)$/gm, (_, head, tc, tail) => `${head}${symbol.get(tc) ?? '⬜'}${tail}`);
if (nextPlan !== plan) writeFileSync(planPath, nextPlan);

// ---- Archive a heal proposal that belongs to an earlier run ----
let archivedHeal = null;
if (runStart && existsSync(healPath) && statSync(healPath).mtime < runStart) {
  const t = statSync(healPath).mtime;
  const pad = (n) => String(n).padStart(2, '0');
  archivedHeal = path.join(dir, `heal-proposal.${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.md`);
  renameSync(healPath, archivedHeal);
}

// ---- Summary for the tester (the runner relays this) ----
console.log(`\n══ GATE: ${decision} ${icon} — ${host} ══`);
if (staleMcp) console.log(`⚠️ mcp-results.json cũ hơn lần chạy này — ${staleMcp} case tính là chưa kiểm chứng. Chạy lại các case MCP.`);
console.log(`Test case: ${passed}/${total} pass (${failed} fail, ${skipped} skip)  ·  P0 ${fmtRate(P0)} · P1 ${fmtRate(P1)} · P2 ${fmtRate(P2)} · P3 ${fmtRate(P3)}`);
if (changes) console.log(`So với ${previous.runId}: ${changes.newFail.length} mới fail, ${changes.fixed.length} hết fail, ${changes.stillFail.length} vẫn fail`);
if (requirements.length) console.log(`Requirement: đã xác nhận ${reqTotals.confirmed_passed}/${reqTotals.confirmed_total} đạt · chấp nhận tạm ${reqTotals.provisional_passed}/${reqTotals.provisional_total} · chờ trả lời ${reqTotals.questions}`);
if (fails.length) {
  console.log('Fail:');
  for (const r of fails) console.log(`  ❌ ${r.tc} [${r.prio}] (${r.tool}) ${cleanTitle(r.title)}  @ ${r.loc}`);
}
if (skips.length) {
  console.log('Chưa kiểm chứng — không tính vào tỉ lệ pass:');
  for (const r of skips) console.log(`  ⏭️ ${r.tc} [${r.prio}] (${r.tool}) ${cleanTitle(r.title)}${r.note ? ` — ${r.note}` : ''}`);
}
for (const w of historyWarnings) console.log(`⚠️ Bỏ qua snapshot hỏng: ${w}`);
console.log(`Báo cáo : ${OUT} — chờ Tester duyệt (G3)`);
console.log(`Lịch sử : ${path.join(dir, 'runs', `${runId}.json`)}`);
console.log(`Plan    : đã cập nhật cột Status trong ${planPath}`);
if (archivedHeal) console.log(`Heal    : proposal cũ đã lưu thành ${archivedHeal}`);
console.log(`HTML    : npx playwright show-report ${path.join(dir, 'html-report')}`);
// Non-zero exit so CI / the orchestrator can block: 1 = real failure, 2 = unverified.
process.exit(decision === 'FAIL' ? 1 : decision === 'BLOCKED' ? 2 : 0);
