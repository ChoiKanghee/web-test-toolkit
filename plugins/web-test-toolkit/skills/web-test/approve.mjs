#!/usr/bin/env node
// approve.mjs — the tester approves one gate (G1–G4). Run by the tester, in a terminal.
//
// Usage: node approve.mjs <url> <G1|G2|G3|G4> --by "<name>"
//
// The command refuses to run without an interactive terminal (stdin and stdout both a TTY), and
// asks the tester to type the gate again before it writes anything: an approval is a person's
// decision, not a step the agent can take for them. It writes the "Đã duyệt" line in the gated
// file and .approvals/<gate>.json; approval.mjs only accepts approved lines backed by that record.
//
// Exit codes: 0 approved, 2 bad usage, 3 refused (no terminal, not confirmed, earlier gate not passed).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { bundleDir, hostOf } from '../test-designer/lib/bundle.mjs';
import { GateError, approveGate, gateStatus } from './lib/approval.mjs';

const args = process.argv.slice(2);
const byIndex = args.indexOf('--by');
const by = byIndex >= 0 ? args[byIndex + 1] : null;
const positional = args.filter((_, i) => i !== byIndex && i !== byIndex + 1);
const [url, gateArg] = positional;
const gate = (gateArg || '').toUpperCase();

if (!url || !/^G[1-4]$/.test(gate) || !by) {
  console.error('Usage: node approve.mjs <url> <G1|G2|G3|G4> --by "<tên tester>"');
  process.exit(2);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Lệnh duyệt phải do tester tự chạy trong terminal (cần nhập xác nhận). '
    + 'Agent không duyệt thay tester. Trên Windows dùng PowerShell / Windows Terminal, không dùng Git Bash.');
  process.exit(3);
}

const dir = bundleDir(url);
const status = gateStatus(dir).find((s) => s.gate === gate);
const file = path.join(dir, status.file);
console.log(`Duyệt ${gate} — ${status.file} — ${hostOf(url)}`);
if (existsSync(file)) {
  const todo = /## Việc của bạn trước khi duyệt[\s\S]*?(?=\n## |$)/u.exec(readFileSync(file, 'utf8'))?.[0];
  if (todo) console.log(`\n${todo.trim()}\n`);
}
console.log(`Trạng thái hiện tại: ${status.state}${status.reason ? ` (${status.reason})` : ''}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`Đã review ${status.file}? Gõ ${gate} để duyệt với tên "${by}" (Enter để huỷ): `)).trim();
rl.close();
if (answer.toUpperCase() !== gate) {
  console.error('Đã huỷ, không ghi gì.');
  process.exit(3);
}

try {
  const result = approveGate(dir, gate, by);
  console.log(`✅ ${result.gate} đã duyệt — ${result.by} — ${result.at} (${result.file}).`);
} catch (error) {
  if (!(error instanceof GateError)) throw error;
  console.error(error.message);
  process.exit(3);
}
