import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reqCoverage, reqGroup, reqSummary } from './req-coverage.mjs';

const REQS = [
  { id: 'REQ-001', description: 'a', status: 'confirmed' },
  { id: 'REQ-002', description: 'b', status: 'confirmed' },
  { id: 'REQ-003', description: 'c', status: 'provisional' },
  { id: 'REQ-004', description: 'd', status: 'provisional' },
  { id: 'REQ-005', description: 'e', status: 'confirmed' },
  { id: 'REQ-006', description: 'f', status: 'question' },
  { id: 'REQ-007', description: 'g', status: 'dropped' },
  { id: 'REQ-008', description: 'h', status: 'unknown' },
];
const PLAN = new Map([
  ['TC-001', ['REQ-001']],
  ['TC-002', ['REQ-001', 'REQ-002']],
  ['TC-003', ['REQ-003']],
  ['TC-004', ['REQ-004']],
  ['TC-005', ['REQ-004']],
  ['TC-006', ['REQ-005']],
  ['TC-008', ['REQ-008']],
]);
const CASES = [
  { tc: 'TC-001', status: 'passed' },
  { tc: 'TC-002', status: 'failed' },
  { tc: 'TC-003', status: 'passed' },
  { tc: 'TC-004', status: 'passed' },
  { tc: 'TC-008', status: 'skipped' },
];

test('reqCoverage gives each requirement one result', () => {
  const byId = Object.fromEntries(reqCoverage(REQS, PLAN, CASES).map((r) => [r.id, r]));
  assert.equal(byId['REQ-001'].result, 'fail', 'one failing TC fails the requirement');
  assert.equal(byId['REQ-002'].result, 'fail');
  assert.equal(byId['REQ-003'].result, 'pass');
  assert.equal(byId['REQ-004'].result, 'unverified', 'TC-005 did not run');
  assert.deepEqual(byId['REQ-004'].missing, ['TC-005']);
  assert.equal(byId['REQ-005'].result, 'notRun');
  assert.equal(byId['REQ-006'].result, 'noTc');
  assert.equal(byId['REQ-008'].result, 'unverified', 'a skipped TC leaves it unverified');
  assert.equal('REQ-007' in byId, false, 'dropped requirements are left out');
});

test('reqGroup counts an unreadable status as confirmed, so it is never hidden', () => {
  assert.equal(reqGroup({ status: 'unknown' }), 'confirmed');
  assert.equal(reqGroup({ status: 'provisional' }), 'provisional');
  assert.equal(reqGroup({ status: 'question' }), 'question');
});

test('reqSummary counts passes per group', () => {
  assert.deepEqual(reqSummary(reqCoverage(REQS, PLAN, CASES)), {
    confirmed_passed: 0, confirmed_total: 4, provisional_passed: 1, provisional_total: 2, questions: 1,
  });
});
