import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeSnapshot } from '../../test-runner/lib/history.mjs';
import {
  GateError, PENDING_LINE, gateStatus, parseApproval, requireGate, unclassifiedFailures,
} from './approval.mjs';

const approved = (at, by = 'Nguyễn Văn A') => `> **Duyệt:** ✅ Đã duyệt — ${by} — ${at}`;
const doc = (title, line) => `# ${title}\n${line}\n\nNội dung.\n`;

function bundle(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'webtest-approval-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

test('parseApproval reads name and time; accepts "-" and a missing ✅', () => {
  assert.deepEqual(parseApproval(doc('Plan', approved('2026-09-28 14:30'))),
    { approved: true, by: 'Nguyễn Văn A', at: '2026-09-28 14:30' });
  assert.deepEqual(parseApproval('# P\n> **Duyệt:** Đã duyệt - Trần-B - 2026-09-28 09:05\n'),
    { approved: true, by: 'Trần-B', at: '2026-09-28 09:05' });
});

test('parseApproval reads an NFD line and a CRLF file', () => {
  const md = doc('Plan', approved('2026-09-28 14:30')).normalize('NFD').replaceAll('\n', '\r\n');
  assert.equal(parseApproval(md).approved, true);
});

test('parseApproval: pending, missing and malformed lines are not approved', () => {
  assert.deepEqual(parseApproval(doc('Plan', PENDING_LINE)), { approved: false, malformed: false });
  assert.deepEqual(parseApproval('# Plan\n'), { approved: false, malformed: false });
  assert.deepEqual(parseApproval(doc('Plan', '> **Duyệt:** ✅ Đã duyệt — A — 28/09/2026')),
    { approved: false, malformed: true });
});

test('gateStatus: missing files, then a pending gate', () => {
  const dir = bundle({ 'requirements.md': doc('R', approved('2026-09-28 10:00')), 'test-plan.md': doc('P', PENDING_LINE) });
  assert.deepEqual(gateStatus(dir).map((s) => s.state), ['approved', 'pending', 'missing', 'missing']);
});

test('gateStatus: a gate approved before the previous one is stale', () => {
  const dir = bundle({
    'requirements.md': doc('R', approved('2026-09-28 15:00')),
    'test-plan.md': doc('P', approved('2026-09-28 14:30')),
  });
  const g2 = gateStatus(dir)[1];
  assert.equal(g2.state, 'stale');
  assert.match(g2.reason, /test-plan\.md được duyệt lúc 2026-09-28 14:30, trước khi requirements\.md được duyệt lúc 2026-09-28 15:00/);
});

test('gateStatus: an approved gate whose previous gate is not passed is stale', () => {
  const dir = bundle({ 'requirements.md': doc('R', PENDING_LINE), 'test-plan.md': doc('P', approved('2026-09-28 14:30')) });
  assert.deepEqual(gateStatus(dir)[1], {
    gate: 'G2', file: 'test-plan.md', state: 'stale', by: 'Nguyễn Văn A', at: '2026-09-28 14:30', reason: 'G1 chưa qua',
  });
});

test('gateStatus: a malformed approval line says so', () => {
  const dir = bundle({ 'requirements.md': doc('R', '> **Duyệt:** ✅ Đã duyệt — A — hôm qua') });
  assert.equal(gateStatus(dir)[0].state, 'pending');
  assert.match(gateStatus(dir)[0].reason, /dòng duyệt sai định dạng/);
});

function g3Bundle(heal) {
  const dir = bundle({
    'requirements.md': doc('R', approved('2026-09-28 08:00')),
    'test-plan.md': doc('P', approved('2026-09-28 08:30')),
    'quality-gate.md': doc('Q', approved('2026-09-28 10:00')),
  });
  writeSnapshot(dir, {
    runId: '2026-09-28T09-00-00Z', startedAt: '2026-09-28T09:00:00.000Z', decision: 'FAIL',
    cases: [
      { tc: 'TC-001', prio: 'P0', tool: 'PW', status: 'passed' },
      { tc: 'TC-004', prio: 'P0', tool: 'PW', status: 'failed' },
      { tc: 'TC-10', prio: 'P1', tool: 'PW', status: 'failed' },
    ],
  });
  if (heal) {
    const file = path.join(dir, 'heal-proposal.md');
    writeFileSync(file, heal.text);
    utimesSync(file, heal.time, heal.time);
  }
  return dir;
}

test('G3 is not passed while a failed TC is missing from the current heal proposal', () => {
  const dir = g3Bundle(null);
  assert.deepEqual(unclassifiedFailures(dir), ['TC-004', 'TC-10']);
  const g3 = gateStatus(dir)[2];
  assert.equal(g3.state, 'stale');
  assert.deepEqual(g3.unclassified, ['TC-004', 'TC-10']);
  assert.match(g3.reason, /2 TC fail chưa phân loại \(TC-004, TC-10\)/);
});

test('G3 passes once every failed TC is in a heal proposal written after the run', () => {
  const after = new Date('2026-09-28T09:30:00Z');
  const dir = g3Bundle({ text: '# Heal\n| TC-004 | bug thật |\n| TC-10 | bug thật |\n', time: after });
  assert.deepEqual(unclassifiedFailures(dir), []);
  assert.equal(gateStatus(dir)[2].state, 'approved');
});

test('a heal proposal older than the run, or naming TC-1 instead of TC-10, does not classify', () => {
  const before = new Date('2026-09-28T08:00:00Z');
  assert.deepEqual(unclassifiedFailures(g3Bundle({ text: 'TC-004 TC-10', time: before })), ['TC-004', 'TC-10']);
  const after = new Date('2026-09-28T09:30:00Z');
  assert.deepEqual(unclassifiedFailures(g3Bundle({ text: 'TC-004 TC-1', time: after })), ['TC-10']);
});

test('requireGate returns the status when passed and throws a GateError otherwise', () => {
  const dir = bundle({ 'requirements.md': doc('R', approved('2026-09-28 10:00')), 'test-plan.md': doc('P', PENDING_LINE) });
  assert.equal(requireGate(dir, 'G1').state, 'approved');
  assert.throws(() => requireGate(dir, 'G2'), (error) => error instanceof GateError
    && error.message === 'G2 chưa qua: test-plan.md chờ duyệt. Bước tiếp: Tester review và duyệt test-plan.md.');
});

test('requireGate names the earliest gate that blocks, with its own reason and next step', () => {
  const noRequirements = bundle({ 'test-plan.md': doc('P', approved('2026-09-28 14:30')) });
  assert.throws(() => requireGate(noRequirements, 'G2'),
    { message: 'G2 chưa qua vì G1 chưa qua: requirements.md chưa có file. Bước tiếp: bước 1 — requirement-analyst viết requirements.md.' });
  const malformed = bundle({ 'requirements.md': doc('R', '> **Duyệt:** ✅ Đã duyệt — A — hôm qua'), 'test-plan.md': doc('P', approved('2026-09-28 14:30')) });
  assert.throws(() => requireGate(malformed, 'G2'), { message: /^G2 chưa qua vì G1 chưa qua: requirements\.md: dòng duyệt sai định dạng/ });
  const pendingBoth = bundle({ 'requirements.md': doc('R', PENDING_LINE), 'test-plan.md': doc('P', PENDING_LINE) });
  assert.throws(() => requireGate(pendingBoth, 'G3'),
    { message: 'G3 chưa qua vì G1 chưa qua: requirements.md chờ duyệt. Bước tiếp: Tester review và duyệt requirements.md.' });
  assert.throws(() => requireGate(g3Bundle(null), 'G4'),
    { message: 'G4 chưa qua vì G3 chưa qua: 2 TC fail chưa phân loại (TC-004, TC-10). Bước tiếp: chạy self-healer cho TC-004, TC-10.' });
});

test('only the approval line under the title counts, not an approved line further down', () => {
  const md = `# Plan\n${PENDING_LINE}\n\nVí dụ:\n\n${approved('2026-09-28 14:30')}\n`;
  assert.deepEqual(parseApproval(md), { approved: false, malformed: false });
});
