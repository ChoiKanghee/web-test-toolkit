// approval.testkit.mjs — for unit tests only: write the approval records that approve.mjs would
// write for every gate file whose line already says "Đã duyệt", so fixtures built from markdown
// pass the record check. Never used by a script of the workflow.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RECORD_DIR, parseApproval } from './approval.mjs';

const FILES = { G1: 'requirements.md', G2: 'test-plan.md', G3: 'quality-gate.md', G4: 'bug-report.md' };

export function recordApprovedLines(dir) {
  for (const [gate, file] of Object.entries(FILES)) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    const approval = parseApproval(readFileSync(full, 'utf8'));
    if (!approval.approved) continue;
    mkdirSync(path.join(dir, RECORD_DIR), { recursive: true });
    writeFileSync(path.join(dir, RECORD_DIR, `${gate}.json`),
      JSON.stringify({ gate, file, by: approval.by, at: approval.at }));
  }
  return dir;
}
