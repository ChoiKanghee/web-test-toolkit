---
name: result-analyst
description: Turn an approved test run into a standard bug report and a Jira CSV — group failures by cause, keep bug ids stable across runs, save the evidence, and write a release recommendation. Use when asked for a bug report, bug list, test summary or release recommendation after tests ran, or to export bugs to Jira. Produces artifacts/<host>/bug-report.md for the tester to approve (gate G4), then bugs.csv. Step 4 of the web-test workflow.
---

Review and analyse the results of a test run. Step 4 of the `web-test` workflow. Input: a run
whose `quality-gate.md` passed gate **G3**. Output: `artifacts/<host>/bug-report.md`, which the
tester approves (gate **G4**), then `artifacts/<host>/bugs.csv` for Jira.

Run from the tester's work folder.

## Start

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/web-test/gate.mjs" https://app.example.com
```

G3 must show ✅. If not, go back: failures still need `self-healer`, or the tester has not
approved the quality gate.

## Read

`quality-gate.md` (decision, comparison with the previous run, requirement coverage),
`heal-proposal.md` (which failures are real bugs, and their diagnosed cause), `runs/*.json`,
`requirements.md`, `test-plan.md`, `mcp-results.json`, and the evidence in
`artifacts/<host>/test-results/`.

## What to achieve

1. **One bug per cause.** Failed TCs with the same diagnosed cause become one bug listing all of
   them. A bug found outside any TC (during exploration or healing) is still a bug, with TC `—`.
2. **Stable ids.** `bug-report.md` is updated in place. A bug already in it (matched by its TCs)
   keeps its `BUG-NNN`; new bugs take the next id after the highest. Trạng thái:
   `Mới` (first seen), `Vẫn còn` (seen before, still failing), `Đã sửa` (its TCs pass again —
   the tester confirms). Record "Lần đầu phát hiện" as the runId of the first run that saw it.
3. **Save the evidence.** Copy each bug's screenshot and trace (and any MCP screenshot) to
   `artifacts/<host>/bugs/BUG-NNN/`. Playwright empties `test-results/` on every run.
   A trace records every value typed into the page (the test password included) and the session
   tokens, so it stays on this machine: list only screenshots in **Bằng chứng**, the field that
   goes to Jira.
4. **Steps in the user's words**, never selectors: from the TC's "Các bước" plus self-healer's
   reproduction on the live page.
5. **Propose Mức độ and Ưu tiên**; the tester adjusts them.
   - Ưu tiên from the TC priority: P0 → Highest, P1 → High, P2 → Medium, P3 → Low.
   - Mức độ: Critical (blocks a main flow, loses data, security hole), Major (wrong behaviour,
     a workaround exists), Minor, Trivial (cosmetic).
6. **Kết luận & khuyến nghị:** Không phát hành / Phát hành có điều kiện / Phát hành, why, and the
   risks still open (unverified REQs, unanswered questions, unstable TCs).
7. Fill the "Tổng hợp" table and "Việc của bạn trước khi duyệt", leave the approval line at
   `⬜ Chờ duyệt`, stop at G4.

Only for a host with no bug report yet:

```bash
cp -n "${CLAUDE_PLUGIN_ROOT}/skills/result-analyst/templates/bug-report.template.md" artifacts/<host>/bug-report.md
```

Field names and allowed values are read by `bugs.mjs`: keep `## BUG-NNN: <title>` headings and
`**<Tên>:** <giá trị>` fields exactly as in the template. Any content change to an approved
report resets its approval line to `⬜ Chờ duyệt`; filling a Jira key does not.

## Hand off (G4), then export

Tell the tester in plain Vietnamese: the recommendation, new / still open / fixed bugs, and the
path. After they say "duyệt", write the approval line
`> **Duyệt:** ✅ Đã duyệt — <name> — <YYYY-MM-DD HH:mm>` (same rule as the other gates), then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/result-analyst/bugs.mjs" https://app.example.com
```

It exports bugs that are not `Đã sửa` and have no Jira key to `bugs.csv`. Tell the tester where
it is, that screenshots must be attached by hand from `bugs/BUG-NNN/` (never `trace.zip`: it
holds the test password and tokens), and to write each Jira key
into the bug's `**Jira:**` field (or ask you to).

## Gotchas
- Exit 3 from `bugs.mjs`: G3 or G4 is not passed — it says which.
- Exit 1: a bug misses a required field or has an unknown Mức độ / Ưu tiên / Trạng thái; fix
  those bugs and re-run. Nothing is written until all bugs are valid.
- A failure self-healer called a broken script is **not** a bug; never list it here.
