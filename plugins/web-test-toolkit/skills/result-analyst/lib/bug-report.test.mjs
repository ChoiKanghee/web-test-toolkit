import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportable, parseBugReport, toJiraCsv, validateBug } from './bug-report.mjs';

const FIXTURE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'bug-report.md'), 'utf8')
  .replace(/\r\n/g, '\n');

test('parseBugReport reads one bug per "## BUG-NNN:" section with single, shared and multi-line fields', () => {
  const bugs = parseBugReport(FIXTURE);
  assert.deepEqual(bugs.map((b) => b.id), ['BUG-001', 'BUG-002', 'BUG-003']);
  const [first] = bugs;
  assert.equal(first.title, 'Sai mật khẩu vẫn vào được, dù "đã" chặn');
  assert.equal(first.fields['Mức độ'], 'Critical');
  assert.equal(first.fields['Trạng thái'], 'Mới');
  assert.equal(first.fields.TC, 'TC-004, TC-007');
  assert.equal(first.fields['Lần đầu phát hiện'], '2026-09-28T07-30-12Z');
  assert.equal(first.fields['Môi trường'], 'https://staging.app.test/login · Chromium');
  assert.equal(first.fields.Jira, '');
  assert.equal(first.fields['Các bước tái hiện'], '1. Mở trang Đăng nhập\n2. Nhập email đúng, mật khẩu "sai, rất sai"\n3. Bấm "Đăng nhập"');
  assert.equal(first.fields['Bằng chứng'], '`bugs/BUG-001/screenshot.png`, `bugs/BUG-001/trace.zip`');
  assert.equal(bugs[1].fields.Jira, 'APP-12');
});

test('parseBugReport reads NFD text and CRLF files the same way', () => {
  const bugs = parseBugReport(FIXTURE.normalize('NFD').replaceAll('\n', '\r\n'));
  assert.equal(bugs[0].fields['Trạng thái'], 'Mới');
  assert.equal(bugs[0].fields['Thực tế'], 'Chuyển vào trang chủ');
});

test('validateBug accepts any letter case and names each missing or invalid field', () => {
  const bugs = parseBugReport(FIXTURE);
  assert.deepEqual(bugs.map(validateBug), [[], [], []]);
  const broken = { id: 'BUG-009', title: 'x', fields: { 'Mức độ': 'Nặng', 'Ưu tiên': 'High', 'Trạng thái': 'Mới', 'Kỳ vọng': 'a' } };
  assert.deepEqual(validateBug(broken), [
    'Mức độ phải là một trong: Critical, Major, Minor, Trivial (đang là "Nặng")',
    'thiếu Các bước tái hiện',
    'thiếu Thực tế',
  ]);
});

test('exportable leaves out fixed bugs and bugs that already have a Jira key', () => {
  assert.deepEqual(exportable(parseBugReport(FIXTURE)).map((b) => b.id), ['BUG-001']);
});

test('a horizontal rule after the last bug is not part of its last field', () => {
  const md = '## BUG-001: A\n**Thực tế:** broken\n**Bằng chứng:** `bugs/BUG-001/screenshot.png`\n\n---\n\n## Chờ xác nhận\n';
  assert.equal(parseBugReport(md)[0].fields['Bằng chứng'], '`bugs/BUG-001/screenshot.png`');
  assert.equal(parseBugReport(md.replace(/\n/g, '\r\n'))[0].fields['Bằng chứng'], '`bugs/BUG-001/screenshot.png`');
});

test('a dash in the Jira field means no key yet; anything else that is not a key is an error', () => {
  const withDash = parseBugReport(FIXTURE.replace('- **Jira:**\n\n**Điều kiện trước:**', '- **Jira:** —\n\n**Điều kiện trước:**'));
  assert.deepEqual(exportable(withDash).map((b) => b.id), ['BUG-001']);
  assert.deepEqual(validateBug(withDash[0]), []);
  const withNote = parseBugReport(FIXTURE.replace('- **Jira:**\n\n**Điều kiện trước:**', '- **Jira:** xem sau\n\n**Điều kiện trước:**'));
  assert.deepEqual(validateBug(withNote[0]), ['Jira phải để trống, "—", hoặc là mã ticket như PROJ-123 (đang là "xem sau")']);
});

test('toJiraCsv quotes commas, quotes and newlines, uses CRLF and no BOM', () => {
  const csv = toJiraCsv(parseBugReport(FIXTURE).slice(0, 2), 'app.test');
  assert.ok(!csv.startsWith('﻿'));
  assert.ok(csv.endsWith('\r\n'));
  const [header] = csv.split('\r\n');
  assert.equal(header, 'Summary,Issue Type,Priority,Description,Environment,Labels,Labels,Labels,Labels,Labels,Labels');
  assert.ok(csv.includes('\r\n"BUG-001: Sai mật khẩu vẫn vào được, dù ""đã"" chặn",Bug,Highest,"Mức độ:\nCritical'));
  assert.ok(csv.includes('mật khẩu ""sai, rất sai""'));
  assert.ok(csv.includes(',https://staging.app.test/login · Chromium,web-test,app.test,severity-critical,TC-004,TC-007,REQ-001\r\n'));
  assert.ok(csv.includes('\r\nBUG-002: Nút Lưu lệch trên mobile,Bug,Low,'));
  assert.ok(csv.includes(',web-test,app.test,severity-trivial,,,\r\n'), 'short label lists are padded');
});
