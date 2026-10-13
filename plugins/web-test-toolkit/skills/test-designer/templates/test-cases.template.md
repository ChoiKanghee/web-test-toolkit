# Test plan — <SITE>
> **Duyệt:** ⬜ Chờ duyệt

> **Việc của bạn trước khi duyệt (G2)**
> - <vd: Kiểm P0/P1 có đúng là những gì quan trọng nhất>
> - <vd: Kiểm "Kỳ vọng" của 5 TC gắn với REQ "Chấp nhận tạm">
> - <vd: 3 REQ "Cần hỏi" chưa có TC — xem mục "Requirement chờ trả lời">

> Thiết kế từ `requirements.md` (duyệt <ngày>) và khảo sát `<URL>` ngày <DATE>.
> Method: black-box, risk-based (BMAD testarch style). Status: ⬜ chưa chạy · ✅ pass · ❌ fail · ⏭️ skip

## Phạm vi & môi trường
- Target: `<URL>`
- Môi trường: <staging | production>  (test ghi/sửa dữ liệu → dùng staging)
- Tài khoản test: <có / không — không ghi mật khẩu ở đâu cả; tester tự đăng nhập trên cửa sổ trình duyệt>

## Route / chức năng không test (và lý do)
> Mọi route và mọi nút/ô nhập/link mà exploration tìm thấy phải có TC, hoặc nằm ở bảng này.
> `coverage.mjs` kiểm cả hai.

| Route / chức năng | Lý do không test | Cần gì để test |
|---|---|---|
| <vd: `/teams/config`> | <vd: chỉ chạy trong Microsoft Teams> | <vd: tenant M365 + app đã cài> |

## Requirement chờ trả lời (chưa có TC)
> REQ đang "Cần hỏi" trong `requirements.md`. Có trả lời → cập nhật requirements.md, duyệt lại
> G1, rồi thêm TC ở đây.

| REQ | Câu hỏi đang chờ |
|---|---|
| <vd: REQ-004> | <vd: Ngưỡng miễn phí ship?> |

## Risk assessment (probability × impact = score)
Score ≥6 ⇒ P0 · 3–4 ⇒ P1 · 1–2 ⇒ P2/P3. Category: SEC/PERF/DATA/BUS/TECH/OPS.

| Risk ID | Category | Mô tả rủi ro | P (1-3) | I (1-3) | Score | Giảm thiểu (test nào phủ) |
|---|---|---|---|---|---|---|
| R-001 | SEC | <vd: đăng nhập sai vẫn vào được> | 2 | 3 | 6 | TC-004 |
| R-002 | BUS | <vd: form không validate> | 2 | 2 | 4 | TC-003 |

## Priority → cadence (khi nào chạy)
- **P0** (critical, score ≥6, chặn luồng chính): chạy **mỗi commit** — gate phải 100%
- **P1** (high, score 3–4): chạy **mỗi PR** — gate ≥95%
- **P2** (medium): chạy **nightly** — informational
- **P3** (low/exploratory): **on-demand**

## Test cases
> Bảng này là "hợp đồng" để script-generator / test-runner đọc. **User sửa trực tiếp được.**
> - Cột **Tool**: `PW` = script-generator sinh Playwright spec · `MCP` = test-runner tự lái
>   chrome-devtools theo cột "Các bước" (dùng khi DOM động / Playwright khó).
> - Cột **P**: P0–P3 (lấy từ Risk ở trên). script-generator mã hoá vào tiêu đề test
>   `test('TC-001 [P0] ...')` để chấm gate.
> - **Các bước** nhiều bước: ngăn bằng `;` (vd `1. Mở /; 2. Bấm Sign in`).
> - Cột **REQ**: requirement mà TC kiểm (`REQ-001, REQ-002` nếu nhiều). `—` cho kiểm tra kỹ
>   thuật không gắn REQ (lỗi console, link hỏng, a11y). Mọi REQ "Đã xác nhận"/"Chấp nhận tạm"
>   phải có TC hoặc nằm ở mục "không test" — `coverage.mjs` kiểm.

| TC | REQ | P | Tool | Mô tả | Các bước | Kỳ vọng | Status |
|------|------|----|------|----------------|------------------|------------------------|--------|
| TC-001 | REQ-001 | P0 | PW | <mô tả ngắn> | 1. <…>; 2. <…> | <kết quả kiểm chứng được> | ⬜ |
| TC-002 | REQ-002, REQ-003 | P1 | PW | <…> | <…> | <…> | ⬜ |
| TC-010 | — | P1 | MCP | <case DOM động> | 1. <…> | <…> | ⬜ |

## Độ phủ (coverage checklist)
- [ ] Authentication (login đúng/sai/trống, logout, session)
- [ ] Authorization (truy cập URL cấm)
- [ ] Form validation (required, định dạng, biên)
- [ ] Business flow chính (mỗi LUỒNG trong requirements.md có ít nhất một TC đi hết luồng)
- [ ] Negative & edge cases
- [ ] Responsive (mobile/tablet/desktop)
- [ ] Performance (Lighthouse / Core Web Vitals)
- [ ] a11y (keyboard, ARIA, contrast)
- [ ] Bảo mật bề mặt (lộ dữ liệu console/network, headers)

## Quality gate (ngưỡng quyết định)
- P0 pass rate **100%** (không ngoại lệ) · P1 **≥95%** · P2/P3 informational
- Không có lỗi bảo mật (SEC) mở · Không rủi ro score ≥6 chưa giảm thiểu
- Quyết định: **PASS** / **CONCERNS** / **BLOCKED** / **FAIL** — sinh tự động bằng `report.mjs`
