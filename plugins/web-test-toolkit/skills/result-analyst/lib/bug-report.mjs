// bug-report.mjs — read bug-report.md (step 4) and turn the bugs a tester approved into a CSV
// Jira can import. Pure.
//
// Each bug is a "## BUG-NNN: <title>" section; its fields are written "**<Tên>:** <giá trị>",
// several per line separated by " · ", or one per line with the value running on to the next
// field or heading (Các bước tái hiện). The "Tổng hợp" table is for reading only.

export const SEVERITIES = ['Critical', 'Major', 'Minor', 'Trivial'];
export const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
export const STATES = ['Mới', 'Vẫn còn', 'Đã sửa'];

const FIELDS = ['Mức độ', 'Ưu tiên', 'Trạng thái', 'TC', 'REQ', 'Lần đầu phát hiện', 'Môi trường', 'Jira',
  'Điều kiện trước', 'Các bước tái hiện', 'Kỳ vọng', 'Thực tế', 'Bằng chứng'];
const FIELD = new RegExp(`\\*\\*(${FIELDS.join('|')}):\\*\\*`, 'gu');
const REQUIRED = ['Các bước tái hiện', 'Kỳ vọng', 'Thực tế'];
const DESCRIPTION = ['Mức độ', 'TC', 'REQ', 'Điều kiện trước', 'Các bước tái hiện', 'Kỳ vọng', 'Thực tế', 'Bằng chứng', 'Lần đầu phát hiện'];

// A value ends where the next field starts; drop the " · ", the "- " bullet or a "---" rule
// left before it.
const clean = (raw) => raw.trim().replace(/(\s*·|\n\s*-{1,3})+$/u, '').trim();
const canonical = (value, allowed) => allowed.find((a) => a.toLowerCase() === (value ?? '').trim().toLowerCase());
const ids = (value) => (value ?? '').split(/[,\s]+/).filter((v) => /^(TC|REQ)-\d+$/.test(v));
// The Jira field holds a ticket key once the bug is imported; empty or a dash means not yet.
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const jiraOf = (fields) => {
  const value = (fields.Jira ?? '').trim();
  return value === '—' || value === '-' ? '' : value;
};

/** Every bug section: `{ id, title, fields }`. */
export function parseBugReport(md) {
  const text = md.normalize('NFC').replace(/\r\n/g, '\n');
  const heads = [...text.matchAll(/^## (BUG-\d+):\s*(.+)$/gm)];
  return heads.map((head) => {
    const start = head.index + head[0].length;
    const next = text.slice(start).search(/^## /m);
    const body = text.slice(start, next === -1 ? undefined : start + next);
    const markers = [...body.matchAll(FIELD)];
    const fields = {};
    markers.forEach((marker, i) => {
      fields[marker[1]] = clean(body.slice(marker.index + marker[0].length, markers[i + 1]?.index ?? body.length));
    });
    return { id: head[1], title: head[2].trim(), fields };
  });
}

/** What is wrong with a bug, in words the tester can act on; empty when it can be exported. */
export function validateBug({ fields }) {
  const problems = [];
  for (const [name, allowed] of [['Mức độ', SEVERITIES], ['Ưu tiên', PRIORITIES], ['Trạng thái', STATES]]) {
    if (!canonical(fields[name], allowed)) {
      problems.push(`${name} phải là một trong: ${allowed.join(', ')} (đang là "${fields[name] ?? ''}")`);
    }
  }
  for (const name of REQUIRED) if (!fields[name]) problems.push(`thiếu ${name}`);
  const jira = jiraOf(fields);
  if (jira && !JIRA_KEY.test(jira)) {
    problems.push(`Jira phải để trống, "—", hoặc là mã ticket như PROJ-123 (đang là "${jira}")`);
  }
  return problems;
}

/** Bugs still to import: not fixed, and no Jira key yet. */
export const exportable = (bugs) =>
  bugs.filter((b) => canonical(b.fields['Trạng thái'], STATES) !== 'Đã sửa' && !jiraOf(b.fields));

const csvCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** Jira CSV: one row per bug, a Labels column repeated as often as the longest label list. */
export function toJiraCsv(bugs, host) {
  const labelsOf = (b) => ['web-test', host, `severity-${canonical(b.fields['Mức độ'], SEVERITIES).toLowerCase()}`,
    ...ids(b.fields.TC), ...ids(b.fields.REQ)];
  const width = Math.max(...bugs.map((b) => labelsOf(b).length));
  const description = (b) => DESCRIPTION
    .filter((name) => b.fields[name])
    .map((name) => `${name}:\n${name === 'Mức độ' ? canonical(b.fields[name], SEVERITIES) : b.fields[name]}`)
    .join('\n\n');
  const header = ['Summary', 'Issue Type', 'Priority', 'Description', 'Environment', ...Array(width).fill('Labels')];
  const rows = bugs.map((b) => {
    const labels = labelsOf(b);
    return [`${b.id}: ${b.title}`, 'Bug', canonical(b.fields['Ưu tiên'], PRIORITIES), description(b),
      b.fields['Môi trường'] ?? '', ...labels, ...Array(width - labels.length).fill('')];
  });
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
