# Test levels — pick the lowest that gives confidence (load when designing tests)

Order of preference (fast/cheap/stable → slow/expensive/flaky): **Unit → Component → API → E2E.**
Push each check as low as it can go while still proving what matters.

| Level | Use for | In this skill |
|---|---|---|
| Unit | pure logic | usually N/A (black-box, no source) |
| Component | one UI piece in isolation | N/A black-box |
| **API** | endpoint contract, status, schema, auth | intercept via network log → assert with `request` |
| **E2E** | real user journey across pages | the default here (Playwright drives the browser) |

Black-box reality: with no source code you mostly live at **E2E + API**. Prefer API-level
assertions where you can observe the endpoint (cheaper, less flaky than full E2E).

**Defense in depth** (acceptable overlap): same criterion at API (logic) + E2E (journey) is fine.
**Unacceptable duplication**: identical assertion at two levels — consolidate.

Avoid the **ice-cream cone** (all E2E): it's slow and flaky. Cover the same risk with the
cheapest sufficient level, reserve E2E for genuine cross-page journeys.
