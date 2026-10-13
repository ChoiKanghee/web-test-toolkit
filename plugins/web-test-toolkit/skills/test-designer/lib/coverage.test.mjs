import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCoverage, parseOutline, parsePlan, renderCoverage, routePattern } from './coverage.mjs';

const ORIGIN = 'https://app.test';
const OUTLINE = `# Exploration report — app.test

- **Entered URL:** https://app.test/history
- **Final URL:** https://app.test/history

## Interactive surface (raw material for test cases)
### Fields (3)
- \`input[type=search]\` name=\`\` — Search by keyword...
- \`select\` name=\`\` — All output languagesTo JapaneseTo English
- \`input[type=checkbox]\` name=\`\` —

### Buttons (3)
- Delete selected
- (no text)
- Export CSV

### Links (3)
- Home → /home
- Meeting#1Unfinished → /meetings/9c57
- React Plus → https://reactplus.test/
`;

const PLAN = `# Test plan

## Route không test (và lý do)
| Route | Lý do |
|---|---|
| \`/teams/config\` | cần Teams |
| Export CSV | gửi file ra ngoài |

## Test cases
| TC | P | Tool | Mô tả | Các bước | Kỳ vọng | Status |
|---|---|---|---|---|---|---|
| TC-001 | P0 | PW | Home | 1. Mở https://app.test/home | Heading | ⬜ |
| TC-002 | P1 | PW | Tìm | 1. Mở /history; 2. Gõ vào "Search by keyword..."; 3. Chọn "All output languages" | Lọc được | ⬜ |
| TC-003 | P2 | PW | Chi tiết | 1. Mở /meetings/<id> | Có "Delete selected" | ⬜ |
| TC-004 | P2 | PW | Gốc | 1. Mở / khi chưa đăng nhập | Về /login | ⬜ |

## Độ phủ
- /settings là ghi chú ngoài bảng, không được tính
`;

test('parseOutline reads the page URL and every labelled control', () => {
  const outline = parseOutline(OUTLINE);
  assert.equal(outline.page, '/history');
  assert.deepEqual(outline.fields, ['Search by keyword...', 'All output languages', '']);
  assert.deepEqual(outline.buttons, ['Delete selected', '', 'Export CSV']);
  assert.deepEqual(outline.links, [
    { label: 'Home', href: '/home' },
    { label: 'Meeting#1Unfinished', href: '/meetings/9c57' },
    { label: 'React Plus', href: 'https://reactplus.test/' },
  ]);
});

test('parsePlan keeps TC rows and the not-tested section, nothing else', () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(plan.rows.map((r) => r.tc), ['TC-001', 'TC-002', 'TC-003', 'TC-004']);
  assert.ok(plan.notTested.includes('/teams/config'));
  assert.ok(!plan.notTested.includes('/settings'));
  assert.ok(!plan.rows.some((r) => r.text.includes('/settings')));
});

test('routePattern matches a path, fills :params, and respects path boundaries', () => {
  assert.ok(routePattern('/home').test('mở /home rồi'));
  assert.ok(!routePattern('/home').test('mở /homepage'));
  assert.ok(routePattern('/meetings/:id').test('mở /meetings/<id>'));
  assert.ok(routePattern('/meetings/:id').test('mở /meetings/9c57.'));
  assert.ok(!routePattern('/meetings/:id').test('mở /meetings/<id>/live'));
  assert.ok(routePattern('/').test('mở / khi chưa'));
  assert.ok(!routePattern('/').test('mở /home'));
});

function coverage(routes = ['/', '/home', '/history', '/meetings/:id', '/settings', '/teams/config']) {
  return checkCoverage({ routes, outlines: [parseOutline(OUTLINE)], plan: parsePlan(PLAN), origin: ORIGIN });
}

test('checkCoverage: a route is covered by a TC row (host stripped) or listed as not tested', () => {
  const byRoute = Object.fromEntries(coverage().routes.map((r) => [r.route, r]));
  assert.deepEqual(byRoute['/home'].tcs, ['TC-001']);
  assert.deepEqual(byRoute['/meetings/:id'].tcs, ['TC-003']);
  assert.deepEqual(byRoute['/'].tcs, ['TC-004']);
  assert.equal(byRoute['/teams/config'].notTested, true);
  assert.equal(byRoute['/settings'].covered, false, 'a mention outside the table does not count');
});

test('checkCoverage: controls match by label; links also by a covered target route', () => {
  const result = coverage();
  const find = (kind, label) => result.controls.find((c) => c.kind === kind && c.label === label);
  assert.deepEqual(find('field', 'Search by keyword...').tcs, ['TC-002']);
  assert.deepEqual(find('field', 'All output languages').tcs, ['TC-002']);
  assert.deepEqual(find('button', 'Delete selected').tcs, ['TC-003']);
  assert.equal(find('button', 'Export CSV').notTested, true);
  assert.equal(find('link', 'Meeting#1Unfinished').covered, true, 'its target /meetings/:id is covered');
  assert.equal(find('link', 'React Plus').covered, false);
  assert.deepEqual(result.unlabeled, [{ kind: 'field', page: '/history' }, { kind: 'button', page: '/history' }]);
  assert.deepEqual(result.gaps.map((g) => g.label ?? g.route), ['/settings', 'React Plus']);
});

test('checkCoverage lists a control once even when many pages repeat it', () => {
  const again = parseOutline(OUTLINE.replaceAll('/history', '/upcoming'));
  const result = checkCoverage({ routes: [], outlines: [parseOutline(OUTLINE), again], plan: parsePlan(PLAN), origin: ORIGIN });
  const home = result.controls.filter((c) => c.label === 'Home');
  assert.equal(home.length, 1);
  assert.deepEqual(home[0].pages, ['/history', '/upcoming']);
});

test('renderCoverage puts the gaps first and says when there are none', () => {
  const md = renderCoverage(coverage(), 'app.test');
  assert.ok(md.startsWith('# Coverage — app.test'));
  assert.ok(md.indexOf('## Gaps') < md.indexOf('## Routes'));
  assert.ok(md.includes('| /settings |'));
  const clean = renderCoverage(coverage(['/home']), 'app.test');
  assert.ok(clean.includes('React Plus'), 'still a gap: an uncovered control');
  const none = renderCoverage(checkCoverage({ routes: ['/home'], outlines: [], plan: parsePlan(PLAN), origin: ORIGIN }), 'app.test');
  assert.ok(none.includes('_None — every route and control maps to a TC or a stated reason._'));
});

const REQS = [
  { id: 'REQ-001', description: 'Tìm theo từ khoá', status: 'confirmed' },
  { id: 'REQ-002', description: 'Xuất CSV', status: 'provisional' },
  { id: 'REQ-003', description: 'Phí ship', status: 'question' },
  { id: 'REQ-004', description: 'In PDF', status: 'dropped' },
  { id: 'REQ-005', description: 'Xoá hàng loạt', status: 'confirmed' },
];
const REQ_PLAN = parsePlan(`## Route không test (và lý do)
| REQ-002 | cần tài khoản admin |

## Test cases
| TC | REQ | P | Tool | Mô tả | Các bước | Kỳ vọng | Status |
|---|---|---|---|---|---|---|---|
| TC-001 | REQ-001 | P1 | PW | Tìm | 1. Mở /history | Lọc được | ⬜ |
| TC-002 | REQ-004, REQ-099 | P2 | PW | Cũ | 1. Mở / | Có | ⬜ |
`);

test('checkCoverage: every confirmed or provisional REQ needs a TC or a stated reason', () => {
  const result = checkCoverage({ routes: [], outlines: [], plan: REQ_PLAN, origin: ORIGIN, requirements: REQS });
  const byId = Object.fromEntries(result.requirements.map((r) => [r.id, r]));
  assert.deepEqual(byId['REQ-001'].tcs, ['TC-001']);
  assert.equal(byId['REQ-002'].notTested, true);
  assert.equal(byId['REQ-005'].covered, false);
  assert.equal('REQ-004' in byId, false, 'a dropped REQ is not checked');
  assert.deepEqual(result.gaps, [
    { kind: 'requirement', label: 'REQ-005 Xoá hàng loạt', pages: [] },
    { kind: 'unknown-req', label: 'REQ-099', pages: [] },
  ]);
  assert.deepEqual(result.droppedInPlan, ['REQ-004']);
});

test('checkCoverage: a REQ awaiting an answer is listed but never a gap', () => {
  const result = checkCoverage({ routes: [], outlines: [], plan: REQ_PLAN, origin: ORIGIN, requirements: REQS });
  assert.equal(result.requirements.find((r) => r.id === 'REQ-003').covered, false);
  assert.ok(!result.gaps.some((g) => g.label.startsWith('REQ-003')));
});

test('renderCoverage adds the REQ → TC matrix only when there are requirements', () => {
  const md = renderCoverage(checkCoverage({ routes: [], outlines: [], plan: REQ_PLAN, origin: ORIGIN, requirements: REQS }), 'app.test');
  assert.ok(md.includes('## Requirements → TC'));
  assert.ok(md.includes('| REQ-001 | Đã xác nhận | Tìm theo từ khoá | TC-001 |'));
  assert.ok(md.includes('| REQ-003 | Cần hỏi | Phí ship | chờ trả lời |'));
  assert.ok(md.includes('| requirement | REQ-005 Xoá hàng loạt |  |'));
  assert.ok(md.includes('Plan vẫn nhắc tới REQ đã bỏ: REQ-004.'));
  assert.ok(!renderCoverage(coverage(), 'app.test').includes('## Requirements → TC'));
});

test('an external URL in the plan does not count as covering the root route', () => {
  const plan = parsePlan('| TC-009 | P3 | PW | Link ngoài | 1. Bấm React Plus (https://reactplus.test/) | Mở tab mới | ⬜ |');
  const result = checkCoverage({ routes: ['/'], outlines: [], plan, origin: ORIGIN });
  assert.equal(result.routes[0].covered, false);
});
