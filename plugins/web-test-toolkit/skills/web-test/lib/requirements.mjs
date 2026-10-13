// requirements.mjs — read the requirement table of requirements.md (step 1) and the REQ ids a
// test plan links to each TC (step 2). Shared by coverage.mjs and report.mjs. Pure.
//
// The table is found by its header row: the first cell is "REQ", and the "Mô tả" and
// "Trạng thái" columns are located by name, so extra or reordered columns do not break it.

export const STATUS_LABEL = {
  confirmed: 'Đã xác nhận',
  provisional: 'Chấp nhận tạm',
  question: 'Cần hỏi',
  dropped: 'Bỏ',
  unknown: '(không rõ)',
};

const clean = (text) => text.normalize('NFC').replace(/[*_`]/g, '').trim().toLowerCase();
const STATUS = new Map(Object.entries(STATUS_LABEL).map(([key, label]) => [clean(label), key]));
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

/** Every row of the requirement table: `{ id, description, status }`. */
export function parseRequirements(md) {
  const requirements = [];
  let columns = null;
  for (const line of md.normalize('NFC').split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) {
      columns = null;
      continue;
    }
    const row = cells(line);
    if (clean(row[0]) === 'req') {
      columns = {
        description: row.findIndex((cell) => clean(cell) === 'mô tả'),
        status: row.findIndex((cell) => clean(cell) === 'trạng thái'),
      };
      continue;
    }
    const id = /^REQ-\d+$/.exec(row[0])?.[0];
    if (!columns || !id) continue;
    requirements.push({
      id,
      description: row[columns.description] ?? '',
      status: STATUS.get(clean(row[columns.status] ?? '')) ?? 'unknown',
    });
  }
  return requirements;
}

/** TC id → the REQ ids its plan row mentions (any column), without duplicates. */
export function planRequirements(planMd) {
  const links = new Map();
  for (const line of planMd.split(/\r?\n/)) {
    const tc = /^\|\s*(TC-\d+)\s*\|/.exec(line)?.[1];
    if (tc) links.set(tc, [...new Set(line.match(/\bREQ-\d+\b/g) ?? [])]);
  }
  return links;
}
