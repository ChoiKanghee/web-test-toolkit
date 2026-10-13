---
name: script-generator
description: Generate Playwright test scripts from a test plan. Use when asked to write/generate Playwright specs or automate test cases from a test-plan.md. Reads the TC table and emits artifacts/<host>/tests/*.spec.mjs. Part of step 3 (execute) of the web-test workflow; runs only after the test plan passed gate G2.
---

Turn an approved test plan into runnable Playwright specs. Part of step 3 (execute) of the
`web-test` workflow. Input: `artifacts/<host>/test-plan.md` (TC table, approved at gate G2). Output:
`artifacts/<host>/tests/<area>.spec.mjs`.

Run from the tester's work folder.

## What to achieve
Read the plan's **`## Test cases` table** and, for every row with **`Tool=PW`**,
write a Playwright `test()`. Skip `Tool=MCP` rows — those run via test-runner driving
chrome-devtools, not as specs. Generation is **judgement-driven** (you read the table +
the exploration, then write idiomatic tests) — there is no rigid parser to satisfy.

## How
0. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/web-test/gate.mjs" <url>`; G2 must show ✅ (`playwright test` refuses to
   run otherwise).
1. Read `artifacts/<host>/test-plan.md` and `artifacts/<host>/exploration.md` (real
   selectors/elements observed on the site).
2. **Existing specs are edited, never replaced** — they carry fixes the healer made and the
   user approved. Add a `test()` for each new `Tool=PW` row to the spec for its area. Only for
   an area with no spec yet, start from the template:
   ```bash
   mkdir -p artifacts/<host>/tests
   cp -n "${CLAUDE_PLUGIN_ROOT}/skills/script-generator/templates/example.spec.mjs" artifacts/<host>/tests/<area>.spec.mjs
   ```
3. One `test()` per `Tool=PW` row. **Encode the TC id + priority in the title** so the
   gate scores it: `test('TC-001 [P0] <Mô tả>', async ({ page }) => { ... })`.
4. Translate "Các bước" → actions and "Kỳ vọng" → assertions.
5. Use **resilient locators** — `getByRole`/`getByLabel`/`getByText` over brittle CSS;
   web-first assertions (`await expect(...).toBeVisible()`); `fill()` not `el.value=`.
   See `resources/knowledge/selector-resilience.md`.

Worked example: `examples/brse-login.spec.mjs` (maps TC-001…TC-005 from the brse.ai plan).

## Notes
- Specs use `baseURL` (test-runner sets it from `BASE_URL`), so navigate with `page.goto('/')`, `page.goto('/login')`.
- **Signed-in cases:** the tester signs in by hand (`login.mjs`), and the session is saved to
  `artifacts/<host>/.auth/<role>.json`; the test-runner config exports that folder as
  `process.env.WEBTEST_AUTH_DIR`. Opt in per file or `describe`:
  `test.use({ storageState: `${process.env.WEBTEST_AUTH_DIR}/default.json` })` (another role: its
  own file name). Cases that must start signed out, such as the login form itself, use
  `test.use({ storageState: { cookies: [], origins: [] } })`. A spec never types or reads a real
  password; the case "wrong password is rejected" fills an obviously fake one.
- Group a site's tests by area into one or a few `*.spec.mjs` files under `artifacts/<host>/tests/`.
- Don't invent cases not in the table — if the plan misses something, send it back to test-designer.
- The REQ column is not encoded in specs: the plan links TCs to requirements, and `report.mjs`
  reads it from there.
- **Bring your own data.** Never make a test depend on a record that happens to exist on the site
  (a meeting, an order, a user) — someone deletes it and a dozen cases fail with no app bug.
  Create what the tests need in a fixture, through the site's API where it has one, and delete
  it for good in the fixture's teardown: one worker-scoped record for read-only cases, a
  test-scoped one for each case that edits or deletes. Name them `e2e-*` so leftovers are
  recognisable. Reading a record that belongs to the site's own seed (a system dictionary, a
  plan catalogue) is fine; say so in the plan.
- Hand off to **test-runner** to execute.
