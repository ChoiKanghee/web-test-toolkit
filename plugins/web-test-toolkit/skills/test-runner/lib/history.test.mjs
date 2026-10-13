import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compareRuns, historyStrip, previousSnapshot, readSnapshots, runIdOf, snapshotCases, writeSnapshot,
} from './history.mjs';

const run = (runId, statuses) => ({
  runId,
  startedAt: '2026-09-28T07:30:12.000Z',
  decision: 'PASS',
  cases: Object.entries(statuses).map(([tc, status]) => ({ tc, prio: 'P1', tool: 'PW', status })),
});

test('runIdOf makes a sortable file-safe id from a date', () => {
  assert.equal(runIdOf(new Date('2026-09-28T07:30:12.345Z')), '2026-09-28T07-30-12Z');
});

test('snapshotCases keeps the worst result of a TC reported twice and drops rows without an id', () => {
  const cases = snapshotCases([
    { tc: 'TC-010', prio: 'P1', tool: 'PW', ok: true, skipped: false },
    { tc: 'TC-002', prio: 'P0', tool: 'PW', ok: true, skipped: false },
    { tc: 'TC-002', prio: 'P0', tool: 'MCP', ok: false, skipped: false },
    { tc: 'TC-003', prio: 'P2', tool: 'PW', ok: false, skipped: true },
    { tc: 'TC-003', prio: 'P2', tool: 'PW', ok: true, skipped: false },
    { tc: '—', prio: 'P1', tool: 'PW', ok: false, skipped: false },
  ]);
  assert.deepEqual(cases, [
    { tc: 'TC-002', prio: 'P0', tool: 'MCP', status: 'failed' },
    { tc: 'TC-003', prio: 'P2', tool: 'PW', status: 'skipped' },
    { tc: 'TC-010', prio: 'P1', tool: 'PW', status: 'passed' },
  ]);
});

test('writeSnapshot overwrites the same run; readSnapshots returns them oldest first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'webtest-history-'));
  writeSnapshot(dir, run('2026-09-28T07-30-12Z', { 'TC-001': 'failed' }));
  writeSnapshot(dir, run('2026-09-27T07-30-12Z', { 'TC-001': 'passed' }));
  writeSnapshot(dir, run('2026-09-28T07-30-12Z', { 'TC-001': 'passed' }));
  assert.equal(readdirSync(path.join(dir, 'runs')).length, 2);
  const { snapshots, warnings } = readSnapshots(dir);
  assert.deepEqual(snapshots.map((s) => s.runId), ['2026-09-27T07-30-12Z', '2026-09-28T07-30-12Z']);
  assert.equal(snapshots[1].cases[0].status, 'passed');
  assert.deepEqual(warnings, []);
});

test('readSnapshots skips a broken file with a warning, and copes with no runs folder', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'webtest-history-'));
  assert.deepEqual(readSnapshots(dir), { snapshots: [], warnings: [] });
  mkdirSync(path.join(dir, 'runs'));
  writeFileSync(path.join(dir, 'runs', '2026-09-26T00-00-00Z.json'), '{ not json');
  writeSnapshot(dir, run('2026-09-27T00-00-00Z', { 'TC-001': 'passed' }));
  const { snapshots, warnings } = readSnapshots(dir);
  assert.equal(snapshots.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^runs\/2026-09-26T00-00-00Z\.json: /);
});

test('previousSnapshot is the latest run strictly before the given one', () => {
  const snapshots = [run('A1', {}), run('A2', {}), run('A3', {})];
  assert.equal(previousSnapshot(snapshots, 'A3').runId, 'A2');
  assert.equal(previousSnapshot(snapshots, 'A1'), null);
});

test('compareRuns sorts every TC into its group', () => {
  const previous = run('A1', { 'TC-001': 'passed', 'TC-002': 'failed', 'TC-003': 'failed', 'TC-004': 'passed', 'TC-005': 'skipped', 'TC-009': 'passed' });
  const current = run('A2', { 'TC-001': 'failed', 'TC-002': 'failed', 'TC-003': 'passed', 'TC-004': 'skipped', 'TC-005': 'failed', 'TC-010': 'passed' });
  assert.deepEqual(compareRuns(current, previous), {
    newFail: ['TC-001', 'TC-005'],
    fixed: ['TC-003'],
    stillFail: ['TC-002'],
    newSkip: ['TC-004'],
    added: ['TC-010'],
    removed: ['TC-009'],
  });
});

test('historyStrip lists only TCs that changed, and flags two or more changes as unstable', () => {
  const snapshots = [
    run('A0', { 'TC-001': 'failed' }),
    run('A1', { 'TC-001': 'passed', 'TC-002': 'passed', 'TC-003': 'passed' }),
    run('A2', { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' }),
    run('A3', { 'TC-001': 'passed', 'TC-002': 'passed' }),
    run('A4', { 'TC-001': 'passed', 'TC-002': 'failed', 'TC-003': 'passed' }),
    run('A5', { 'TC-001': 'failed', 'TC-002': 'failed', 'TC-003': 'passed' }),
  ];
  assert.deepEqual(historyStrip(snapshots), [
    { tc: 'TC-001', statuses: ['passed', 'failed', 'passed', 'passed', 'failed'], changes: 3, unstable: true },
    { tc: 'TC-002', statuses: ['passed', 'passed', 'passed', 'failed', 'failed'], changes: 1, unstable: false },
  ]);
  assert.deepEqual(historyStrip([run('A0', { 'TC-001': 'failed' })]), []);
});
