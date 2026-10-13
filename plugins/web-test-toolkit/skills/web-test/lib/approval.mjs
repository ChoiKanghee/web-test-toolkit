// approval.mjs — the tester's approval gates G1–G4, one per step of the process.
//
// Each gated file carries one line under its title, written by the tester (or by the agent
// after the tester says "duyệt" in chat):
//   > **Duyệt:** ⬜ Chờ duyệt
//   > **Duyệt:** ✅ Đã duyệt — <name> — YYYY-MM-DD HH:mm
// A gate passes when its file is approved, the previous gate passes, and it was approved no
// earlier than the previous gate. G3 also needs every failed TC of the latest run named in a
// heal-proposal.md written after that run. Scripts that must not run before a gate call
// requireGate / requireGatesOrExit; exit code 3 means "blocked by a gate" everywhere.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSnapshots } from '../../test-runner/lib/history.mjs';

const GATES = [
  { gate: 'G1', file: 'requirements.md' },
  { gate: 'G2', file: 'test-plan.md' },
  { gate: 'G3', file: 'quality-gate.md' },
  { gate: 'G4', file: 'bug-report.md' },
];

export const PENDING_LINE = '> **Duyệt:** ⬜ Chờ duyệt';
const LINE = /^> \*\*Duyệt:\*\*.*$/mu;
const APPROVED = /^> \*\*Duyệt:\*\*\s*(?:✅\s*)?Đã duyệt\s*[—-]\s*(.+?)\s*[—-]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/mu;

/**
 * `{ approved, by, at }` from the file's approval line (the first one: an approved line further
 * down, such as a pasted example, does not count); `malformed` when it claims approval but
 * cannot be read.
 */
export function parseApproval(md) {
  const line = LINE.exec(md.normalize('NFC'))?.[0] ?? '';
  const match = APPROVED.exec(line);
  if (match) return { approved: true, by: match[1], at: match[2] };
  return { approved: false, malformed: /Đã duyệt/u.test(line) };
}

/** Failed TCs of the latest run that the current heal-proposal.md does not name. */
export function unclassifiedFailures(dir) {
  const latest = readSnapshots(dir).snapshots.at(-1);
  if (!latest) return [];
  const failed = latest.cases.filter((c) => c.status === 'failed').map((c) => c.tc);
  if (!failed.length) return [];
  const heal = path.join(dir, 'heal-proposal.md');
  const current = existsSync(heal) && statSync(heal).mtime >= new Date(latest.startedAt);
  const text = current ? readFileSync(heal, 'utf8') : '';
  return failed.filter((tc) => !new RegExp(`\\b${tc}\\b`).test(text));
}

/** The state of every gate, in order. */
export function gateStatus(dir) {
  const statuses = [];
  let previous = null;
  for (const { gate, file } of GATES) {
    const full = path.join(dir, file);
    const status = { gate, file };
    if (!existsSync(full)) {
      status.state = 'missing';
    } else {
      const approval = parseApproval(readFileSync(full, 'utf8'));
      const unclassified = gate === 'G3' ? unclassifiedFailures(dir) : [];
      if (gate === 'G3') status.unclassified = unclassified;
      if (!approval.approved) {
        status.state = 'pending';
        if (approval.malformed) status.reason = `${file}: dòng duyệt sai định dạng (cần "— <tên> — YYYY-MM-DD HH:mm")`;
      } else {
        Object.assign(status, { by: approval.by, at: approval.at });
        if (previous && previous.state !== 'approved') {
          Object.assign(status, { state: 'stale', reason: `${previous.gate} chưa qua` });
        } else if (previous && approval.at < previous.at) {
          Object.assign(status, {
            state: 'stale',
            reason: `${file} được duyệt lúc ${approval.at}, trước khi ${previous.file} được duyệt lúc ${previous.at}`,
          });
        } else if (unclassified.length) {
          Object.assign(status, {
            state: 'stale',
            reason: `${unclassified.length} TC fail chưa phân loại (${unclassified.join(', ')})`,
          });
        } else {
          status.state = 'approved';
        }
      }
    }
    statuses.push(status);
    previous = status;
  }
  return statuses;
}

const STEP = {
  G1: 'bước 1 — requirement-analyst viết requirements.md',
  G2: 'bước 2 — test-designer viết test-plan.md',
  G3: 'bước 3 — sinh script, chạy test, rồi chạy report.mjs',
  G4: 'bước 4 — result-analyst viết bug-report.md',
};
const STATE_TEXT = { missing: 'chưa có file', pending: 'chờ duyệt' };

/** Why a gate that has not passed is blocked. */
const whyBlocked = (status) => status.reason ?? `${status.file} ${STATE_TEXT[status.state]}`;

/** What to do next to pass a gate that has not passed, in words for the tester. */
export function nextStep(status) {
  if (status.unclassified?.length) return `chạy self-healer cho ${status.unclassified.join(', ')}`;
  if (status.state === 'missing') return STEP[status.gate];
  if (status.state === 'pending') return `Tester review và duyệt ${status.file}`;
  return `Tester review lại ${status.file}`;
}

export class GateError extends Error {}

/**
 * The gate's status when it has passed; otherwise a GateError naming the earliest gate in the
 * chain that blocks it, that gate's own reason, and the next step.
 */
export function requireGate(dir, gate) {
  const statuses = gateStatus(dir);
  const status = statuses.find((s) => s.gate === gate);
  if (status.state === 'approved') return status;
  const blocker = statuses.find((s) => s.state !== 'approved');
  const head = blocker === status ? `${gate} chưa qua` : `${gate} chưa qua vì ${blocker.gate} chưa qua`;
  throw new GateError(`${head}: ${whyBlocked(blocker)}. Bước tiếp: ${nextStep(blocker)}.`);
}

/** CLI helper: print why a gate blocks and exit 3. */
export function requireGatesOrExit(dir, ...gates) {
  try {
    for (const gate of gates) requireGate(dir, gate);
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(error.message);
    process.exit(3);
  }
}
