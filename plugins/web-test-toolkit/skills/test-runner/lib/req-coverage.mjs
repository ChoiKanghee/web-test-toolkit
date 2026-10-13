// req-coverage.mjs — what one test run says about each requirement. Pure.
//
// A requirement passes only when every TC linked to it ran and passed. One failing TC fails
// it; a skipped or missing TC leaves it unverified. Requirements awaiting an answer have no TC
// by design; dropped ones are left out.

export const REQ_RESULT = {
  pass: 'Đạt',
  fail: 'Không đạt',
  unverified: 'Chưa kiểm chứng',
  notRun: 'Chưa chạy',
  noTc: 'Không có TC',
};

/** Report group of a requirement; an unreadable status counts as confirmed so it stays visible. */
export const reqGroup = (requirement) =>
  (requirement.status === 'provisional' || requirement.status === 'question' ? requirement.status : 'confirmed');

/** One result per requirement from this run's cases (`[{ tc, status }]`). */
export function reqCoverage(requirements, planReqs, cases) {
  const statusOf = new Map(cases.map((c) => [c.tc, c.status]));
  const tcsOf = new Map();
  for (const [tc, reqs] of planReqs) {
    for (const req of reqs) tcsOf.set(req, [...(tcsOf.get(req) ?? []), tc]);
  }
  return requirements.filter((r) => r.status !== 'dropped').map((r) => {
    const tcs = r.status === 'question' ? [] : tcsOf.get(r.id) ?? [];
    const ran = tcs.filter((tc) => statusOf.has(tc));
    const missing = tcs.filter((tc) => !statusOf.has(tc));
    let result = 'pass';
    if (!tcs.length) result = 'noTc';
    else if (!ran.length) result = 'notRun';
    else if (ran.some((tc) => statusOf.get(tc) === 'failed')) result = 'fail';
    else if (missing.length || ran.some((tc) => statusOf.get(tc) === 'skipped')) result = 'unverified';
    return { ...r, tcs, missing, result };
  });
}

/** Pass counts per group, for the summary line and the CI YAML. */
export function reqSummary(results) {
  const inGroup = (group) => results.filter((r) => reqGroup(r) === group);
  const passed = (items) => items.filter((r) => r.result === 'pass').length;
  const confirmed = inGroup('confirmed');
  const provisional = inGroup('provisional');
  return {
    confirmed_passed: passed(confirmed),
    confirmed_total: confirmed.length,
    provisional_passed: passed(provisional),
    provisional_total: provisional.length,
    questions: inGroup('question').length,
  };
}
