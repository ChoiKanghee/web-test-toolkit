// history.mjs — one snapshot per test run under artifacts/<host>/runs/<runId>.json, and the
// comparisons the quality gate draws from them.
//
// Snapshot: { runId, startedAt, decision, cases: [{ tc, prio, tool, status }] } where status is
// 'passed' | 'failed' | 'skipped'. runId sorts in time order, so file order is run order.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RANK = { passed: 0, skipped: 1, failed: 2 };
const byTcNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/** A sortable, file-safe id for a run that started at `date`. */
export const runIdOf = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');

/** One case per TC id; a TC reported more than once keeps its worst result. */
export function snapshotCases(rows) {
  const cases = new Map();
  for (const row of rows) {
    if (!/^TC-\d+$/.test(row.tc)) continue;
    const status = row.skipped ? 'skipped' : row.ok ? 'passed' : 'failed';
    const known = cases.get(row.tc);
    if (!known || RANK[status] > RANK[known.status]) {
      cases.set(row.tc, { tc: row.tc, prio: row.prio, tool: row.tool, status });
    }
  }
  return [...cases.values()].sort((a, b) => byTcNumber(a.tc, b.tc));
}

/** Write (or overwrite) the snapshot of one run. */
export function writeSnapshot(dir, snapshot) {
  const runs = path.join(dir, 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(path.join(runs, `${snapshot.runId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Every readable snapshot, oldest first; unreadable files are reported in `warnings`. */
export function readSnapshots(dir) {
  const runs = path.join(dir, 'runs');
  const snapshots = [];
  const warnings = [];
  if (!existsSync(runs)) return { snapshots, warnings };
  for (const file of readdirSync(runs).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const snapshot = JSON.parse(readFileSync(path.join(runs, file), 'utf8'));
      if (typeof snapshot.runId !== 'string' || !Array.isArray(snapshot.cases)) throw new Error('not a run snapshot');
      snapshots.push(snapshot);
    } catch (error) {
      warnings.push(`runs/${file}: ${error.message}`);
    }
  }
  return { snapshots, warnings };
}

/** The latest snapshot strictly before `runId`, or null. */
export const previousSnapshot = (snapshots, runId) => snapshots.filter((s) => s.runId < runId).at(-1) ?? null;

/** What changed between two runs, as lists of TC ids. */
export function compareRuns(current, previous) {
  const before = new Map(previous.cases.map((c) => [c.tc, c.status]));
  const now = new Map(current.cases.map((c) => [c.tc, c.status]));
  const groups = { newFail: [], fixed: [], stillFail: [], newSkip: [], added: [], removed: [] };
  for (const [tc, status] of now) {
    const was = before.get(tc);
    if (was === undefined) groups.added.push(tc);
    else if (status === 'failed') groups[was === 'failed' ? 'stillFail' : 'newFail'].push(tc);
    else if (status === 'passed' && was === 'failed') groups.fixed.push(tc);
    else if (status === 'skipped' && was !== 'skipped') groups.newSkip.push(tc);
  }
  for (const tc of before.keys()) if (!now.has(tc)) groups.removed.push(tc);
  return groups;
}

/**
 * TCs whose result changed at least once in the last `n` runs, with their results (null = not
 * run). Two or more changes is `unstable`: suspect a flaky test before calling it a bug.
 */
export function historyStrip(snapshots, n = 5) {
  const recent = snapshots.slice(-n);
  const tcs = [...new Set(recent.flatMap((s) => s.cases.map((c) => c.tc)))].sort(byTcNumber);
  return tcs.flatMap((tc) => {
    const statuses = recent.map((s) => s.cases.find((c) => c.tc === tc)?.status ?? null);
    const present = statuses.filter(Boolean);
    const changes = present.slice(1).filter((status, i) => status !== present[i]).length;
    return changes ? [{ tc, statuses, changes, unstable: changes >= 2 }] : [];
  });
}
