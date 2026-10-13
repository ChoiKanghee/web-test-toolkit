#!/usr/bin/env node
// bugs.mjs — export the bugs of an approved bug-report.md to a CSV that Jira can import.
//
// Usage: node bugs.mjs <url>     (or BASE_URL=<url>)
// Needs gates G3 and G4 (exit 3 otherwise). A bug with a missing or invalid required field
// stops the export (exit 1) and nothing is written. Exports the bugs that are not "Đã sửa" and
// have no Jira key yet to artifacts/<host>/bugs.csv (overwritten); exit 0, also when there is
// nothing to export. CSV cannot carry attachments: the tester attaches bugs/BUG-NNN/ by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundleDir, hostOf } from '../test-designer/lib/bundle.mjs';
import { requireGatesOrExit } from '../web-test/lib/approval.mjs';
import { exportable, parseBugReport, toJiraCsv, validateBug } from './lib/bug-report.mjs';

const url = process.argv[2] || process.env.BASE_URL;
if (!url) {
  console.error('Usage: node bugs.mjs <url>');
  process.exit(2);
}
const dir = bundleDir(url);
requireGatesOrExit(dir, 'G3', 'G4');

const bugs = parseBugReport(readFileSync(path.join(dir, 'bug-report.md'), 'utf8'));
const invalid = bugs.map((bug) => ({ bug, problems: validateBug(bug) })).filter(({ problems }) => problems.length);
if (invalid.length) {
  console.error('Chưa xuất được bug-report.md — sửa các bug sau rồi chạy lại:');
  for (const { bug, problems } of invalid) console.error(`  ${bug.id}: ${problems.join('; ')}`);
  process.exit(1);
}

const selected = exportable(bugs);
if (!selected.length) {
  console.log(`Không có bug nào cần xuất (${bugs.length} bug đều đã có Jira key hoặc Đã sửa).`);
  process.exit(0);
}
const out = path.join(dir, 'bugs.csv');
writeFileSync(out, toJiraCsv(selected, hostOf(url)));
console.log(`Đã xuất ${selected.length} bug → ${out} (bỏ qua ${bugs.length - selected.length}: đã có Jira key hoặc Đã sửa).`);
console.log('CSV không mang được file đính kèm: sau khi import, đính kèm ảnh trong bugs/BUG-NNN/ vào từng ticket, rồi điền Jira key vào bug-report.md.');
console.log('Không đính kèm trace.zip: trace ghi lại mật khẩu gõ vào form và token phiên của tài khoản test — chỉ mở trong máy.');
