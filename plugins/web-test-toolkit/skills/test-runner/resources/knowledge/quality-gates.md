# Quality gate decision (load when reporting)

`report.mjs` produces this deterministically from Playwright JSON. The model.

**Decision rule (in order):**
1. Any **P0** test failed → **FAIL** ❌ (block; P0 must be 100%)
2. Else any **P0** test skipped → **BLOCKED** ⛔ (unverified, *not* broken — re-run by another
   method before release; never report it as a P0 failure)
3. Else **P1** pass rate < 95% → **CONCERNS** ⚠️ (deploy only with monitoring + remediation backlog)
4. Else some P2/P3 failed → **CONCERNS** ⚠️ (informational; track, don't block)
5. Else some case skipped → **CONCERNS** ⚠️ (coverage incomplete)
6. Else → **PASS** ✅

**Skipped ≠ failed.** A case blocked by a tool or environment limit (no real device, a native
dialog the driver can't accept), or by a missing precondition, is recorded `status: "skipped"`
with a `note` explaining why. Pass rate = passed / (total − skipped): a skip is evidence for
nothing, so it leaves the denominator instead of being scored as a failure. A priority whose
cases were *all* skipped shows a pass rate of `—`, not `100%`.

**WAIVED** 🔓 is a human override of a FAIL for documented business reasons (regulatory deadline,
<1% impact + workaround). Never auto-decided — record approver, expiry, remediation due date.

**Exit codes:** `report.mjs` exits **1 on FAIL** and **2 on BLOCKED** so CI can block the
pipeline on either while telling a real defect apart from an unverified case; 0 otherwise.

**Beyond pass/fail**, a strong gate also weighs (capture in the plan, assert where feasible):
- Coverage: every risk score ≥6 has a covering test
- Security: no SEC issue open (no secrets in console/network/localStorage; security headers present)
- Flakiness: P0 specs stable across reruns (burn-in) before trusting a PASS
