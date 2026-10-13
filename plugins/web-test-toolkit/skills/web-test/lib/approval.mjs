// approval.mjs — the tester's approval gates G1–G4, one per step of the process.
//
// Each gated file carries one line under its title:
//   > **Duyệt:** ⬜ Chờ duyệt
//   > **Duyệt:** ✅ Đã duyệt — <name> — YYYY-MM-DD HH:mm
// The approved line is written only by approve.mjs, which the tester runs in a terminal and
// confirms by typing the gate; it also writes .approvals/<gate>.json with the same name and time.
// An approved line without that record (typed by hand, or by the agent) does not pass: its gate
// is "unverified". A gate passes when its file is approved and verified, the previous gate
// passes, and it was approved no earlier than the previous gate. G3 also needs every failed TC of the latest run named in a
// heal-proposal.md written after that run. Scripts that must not run before a gate call
// requireGate / requireGatesOrExit; exit code 3 means "blocked by a gate" everywhere.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readSnapshots } from '../../test-runner/lib/history.mjs';

const GATES = [
  { gate: 'G1', file: 'requirements.md' },
  { gate: 'G2', file: 'test-plan.md' },
  { gate: 'G3', file: 'quality-gate.md' },
  { gate: 'G4', file: 'bug-report.md' },
];

export const PENDING_LINE = '> **Duyệt:** ⬜ Chờ duyệt';
export const RECORD_DIR = '.approvals';
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

/** The gate's approval record written by approve.mjs, or null. */
export function readRecord(dir, gate) {
  const file = path.join(dir, RECORD_DIR, `${gate}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether the approved line is backed by the tester's record (same gate, file, name, time). */
export function isVerified(dir, gate, file, approval) {
  const record = readRecord(dir, gate);
  return Boolean(record && record.gate === gate && record.file === file
    && record.by === approval.by && record.at === approval.at);
}

/** `YYYY-MM-DD HH:mm`, local time. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The markdown with its approval line set to approved (inserted under the title if missing). */
export function withApprovedLine(md, by, at) {
  const line = `> **Duyệt:** ✅ Đã duyệt — ${by} — ${at}`;
  const text = md.normalize('NFC');
  if (LINE.test(text)) return text.replace(LINE, line);
  const lines = text.split('\n');
  const title = lines.findIndex((l) => /^#\s/.test(l));
  lines.splice(title + 1, 0, line);
  return lines.join('\n');
}

/**
 * Record the tester's approval of one gate: the line in the file and .approvals/<gate>.json.
 * Called by approve.mjs after the tester confirmed in a terminal. Refuses when an earlier gate
 * has not passed or the file is missing; G3 also refuses while failed TCs are unclassified.
 */
export function approveGate(dir, gate, by, at = stamp()) {
  const entry = GATES.find((g) => g.gate === gate);
  if (!entry) throw new GateError(`Không có gate ${gate} (G1–G4).`);
  if (!by || !by.trim()) throw new GateError('Cần tên tester duyệt (--by).');
  const index = GATES.indexOf(entry);
  if (index > 0) requireGate(dir, GATES[index - 1].gate);
  const full = path.join(dir, entry.file);
  if (!existsSync(full)) throw new GateError(`${entry.file} chưa có. Bước tiếp: ${STEP[gate]}.`);
  if (gate === 'G3') {
    const unclassified = unclassifiedFailures(dir);
    if (unclassified.length) {
      throw new GateError(`${unclassified.length} TC fail chưa phân loại (${unclassified.join(', ')}): chạy self-healer trước.`);
    }
  }
  const name = by.trim();
  writeFileSync(full, withApprovedLine(readFileSync(full, 'utf8'), name, at));
  mkdirSync(path.join(dir, RECORD_DIR), { recursive: true });
  writeFileSync(path.join(dir, RECORD_DIR, `${gate}.json`),
    `${JSON.stringify({ gate, file: entry.file, by: name, at }, null, 2)}\n`);
  return { gate, file: entry.file, by: name, at };
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
        if (!isVerified(dir, gate, file, approval)) {
          Object.assign(status, {
            state: 'unverified',
            reason: `${file}: dòng "Đã duyệt" không do tester xác nhận bằng approve.mjs trong terminal`,
          });
        } else if (previous && previous.state !== 'approved') {
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
  if (status.state === 'pending') return `Tester review ${status.file}, rồi tự chạy approve.mjs ${status.gate} trong terminal`;
  if (status.state === 'unverified') return `Tester tự chạy approve.mjs ${status.gate} trong terminal để duyệt ${status.file}`;
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
