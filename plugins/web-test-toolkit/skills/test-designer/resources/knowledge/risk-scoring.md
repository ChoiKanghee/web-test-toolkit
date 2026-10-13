# Risk scoring & priority (load when writing a test plan)

Score = **Probability (1–3) × Impact (1–3)**. Drives priority, which drives cadence.

| Score | Priority | Cadence | Gate |
|---|---|---|---|
| ≥6 | **P0** critical | every commit | must be 100% |
| 3–4 | **P1** high | every PR | ≥95% |
| 2 | **P2** medium | nightly | informational |
| 1 | **P3** low | on-demand | informational |

**Probability** 1=unlikely, 2=possible, 3=likely. **Impact** 1=minor, 2=moderate, 3=severe (data loss, security, blocked core journey).

**Categories:** SEC (auth/access/data exposure) · PERF (latency/SLA) · DATA (loss/corruption) · BUS (UX/logic/revenue) · TECH (integration/scalability) · OPS (deploy/config/monitoring).

Rules of thumb for a black-box web app:
- Login/auth, payment, anything that mutates or exposes user data → usually P0.
- Primary business flow happy-path → P0/P1. Secondary flows → P1/P2.
- Cosmetic/edge/exploratory → P2/P3.
- Every score ≥6 risk MUST have at least one test that covers it (trace Risk → TC).
