#!/usr/bin/env node
// gate.mjs — where a site stands in the four-step process: the state of gates G1–G4 and the
// next step. The agent runs it at the start of every session and every phase.
//
// Usage: node gate.mjs <url>     (or BASE_URL=<url>)
// Exit 0 always, except 2 when no URL is given.

import { bundleDir, hostOf } from '../test-designer/lib/bundle.mjs';
import { gateStatus, nextStep } from './lib/approval.mjs';

const url = process.argv[2] || process.env.BASE_URL;
if (!url) {
  console.error('Usage: node gate.mjs <url>');
  process.exit(2);
}

const ICON = { approved: '✅', pending: '⬜', stale: '⚠️', missing: '—' };

function detail(status) {
  if (status.state === 'approved') return `${status.by} · ${status.at}`;
  if (status.state === 'missing') return 'chưa có';
  if (status.state === 'stale') return `chưa qua: ${status.reason}`;
  const extra = [status.reason, status.unclassified?.length ? `${status.unclassified.length} TC fail chưa phân loại` : null];
  return ['chờ duyệt', ...extra.filter(Boolean)].join(' · ');
}

const statuses = gateStatus(bundleDir(url));
console.log(`Cổng duyệt — ${hostOf(url)}`);
for (const status of statuses) {
  console.log(`  ${status.gate} ${status.file.padEnd(18)} ${ICON[status.state]} ${detail(status)}`);
}
const blocker = statuses.find((s) => s.state !== 'approved');
console.log(`Bước tiếp: ${blocker ? nextStep(blocker) : 'mọi cổng đã qua — chạy bugs.mjs để xuất bugs.csv nếu chưa xuất'}.`);
