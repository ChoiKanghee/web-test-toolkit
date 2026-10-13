---
name: setup
description: Prepare a folder for web testing with web-test-toolkit — install Playwright and Chromium, create artifacts/ and .gitignore, and check the chrome-devtools MCP server. Use when the tester says "setup", when starting in a new or empty work folder, or when a web-test script exits 4 ("Chưa cài Playwright").
---

Prepare the **current folder** as a web-test work folder. Run once per folder; running it again
is safe and only fixes what is missing. Never touch files outside the current folder, and never
write a path to this plugin into the folder — the plugin's location changes when it updates.

Do the steps in order. Record each result as `OK` or what the tester must do; report at the end.

## 1. Node
```bash
node --version
```
Needs **20.12 or later**. Older or missing: stop here and tell the tester to install the
current LTS from https://nodejs.org, then run setup again. Nothing else works without it.

## 2. Chrome
`Tool=MCP` cases drive the real Chrome, not Playwright's Chromium. Check the usual locations:
```bash
ls "/c/Program Files/Google/Chrome/Application/chrome.exe" \
   "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
   "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe" \
   "/Applications/Google Chrome.app" 2>/dev/null; which google-chrome 2>/dev/null
```
None found: a warning, not a stop. Playwright cases still run.

## 3. package.json
- No `package.json` in the folder: create one with exactly
  `{ "name": "web-test-workspace", "private": true, "type": "module" }`.
- One already exists: leave every field as it is. Do not rewrite or reformat it.

## 4. Playwright and Chromium
```bash
node -e "require.resolve('@playwright/test')" 2>/dev/null || npm install -D @playwright/test
npx playwright install chromium
```
The first line installs only when Playwright is not already resolvable from this folder.

## 5. .gitignore
Make sure each of these lines is present, adding only the ones that are missing (create the
file if there is none):
```
node_modules/
artifacts/
```

## 6. Bundle folder
```bash
mkdir -p artifacts
```
No credential file is needed: the tester signs in by hand in a browser window (`login.mjs`),
and the saved session lands in `artifacts/<host>/.auth/`. Never ask for a password in the chat.

## 7. chrome-devtools MCP
Look at the tools available in this session for one whose name ends in
`chrome-devtools__navigate_page`.
- Found: the server is connected. The allow rule for step 8 is that tool's name with
  `__navigate_page` removed.
- Not found: the server only loads at session start. Tell the tester to restart Claude Code and
  run setup again. If it is still missing after a restart, say so in the report; `Tool=MCP`
  cases then run through a scratch Playwright script instead (the test-runner skill covers it).

## 8. Permissions
Edit `.claude/settings.local.json` of the current folder. Create it as
`{ "permissions": { "allow": [], "deny": [] } }` if it does not exist; otherwise keep everything
already in it and add only the rules that are missing.
- **Always**, in `permissions.deny`: `Read(./artifacts/**/.auth/**)`. Saved sessions are loaded
  by the scripts; the agent never needs to open them, and a hostile page must not be able to
  talk it into it.
- **Only when step 7 found the server**, in `permissions.allow`: the rule from step 7, so MCP
  cases run without a prompt per click.

Tell the tester what you added. If the write is declined or blocked, do not retry and do not
stop: finish the report and show the rules there so the tester can approve them later.

## 9. Report (in Vietnamese, plain language)
```
Kết quả setup — <thư mục>
- Node:        OK (vX.Y.Z)            | Cần cài Node 20.12 trở lên
- Playwright:  OK                     | Lỗi: <một dòng>
- Chromium:    OK                     | Lỗi: <một dòng>
- Chrome:      OK                     | Chưa thấy Chrome — các case MCP cần Chrome
- MCP:         Đã kết nối             | Chưa kết nối — khởi động lại Claude Code rồi chạy lại setup
- Quyền MCP:   Đã thêm                | Chưa thêm — cần cho phép ghi .claude/settings.local.json (rule: <rule>)
- Chặn đọc .auth: Đã thêm             | Chưa thêm — cần cho phép ghi .claude/settings.local.json
Bước tiếp theo: nói "test trang <url>" kèm đường dẫn tài liệu yêu cầu (nếu có, để ở đâu
cũng được).
```
Show one value per line: the left one when the check passed, the right one when it did not.
