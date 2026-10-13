# Bug report — app.test
> **Duyệt:** ✅ Đã duyệt — Tester — 2026-09-28 16:00

> **Việc của bạn trước khi duyệt (G4)**
> - Kiểm bước tái hiện của BUG-001

> Lần chạy: 2026-09-28T07-30-12Z · Gate: FAIL · Môi trường: staging · Chromium

## Kết luận & khuyến nghị
- **Khuyến nghị:** Không phát hành
- **Lý do:** BUG-001 chặn luồng đăng nhập.

## Tổng hợp
| BUG | Tiêu đề | Mức độ | Ưu tiên | TC | REQ | Trạng thái | Jira |
|---|---|---|---|---|---|---|---|
| BUG-001 | Sai mật khẩu vẫn vào được | Critical | Highest | TC-004, TC-007 | REQ-001 | Mới | |

## BUG-001: Sai mật khẩu vẫn vào được, dù "đã" chặn
- **Mức độ:** Critical · **Ưu tiên:** Highest · **Trạng thái:** Mới
- **TC:** TC-004, TC-007 · **REQ:** REQ-001 · **Lần đầu phát hiện:** 2026-09-28T07-30-12Z
- **Môi trường:** https://staging.app.test/login · Chromium
- **Jira:**

**Điều kiện trước:** Có tài khoản test, chưa đăng nhập
**Các bước tái hiện:**
1. Mở trang Đăng nhập
2. Nhập email đúng, mật khẩu "sai, rất sai"
3. Bấm "Đăng nhập"

**Kỳ vọng:** Báo lỗi "Sai mật khẩu", vẫn ở trang Đăng nhập
**Thực tế:** Chuyển vào trang chủ
**Bằng chứng:** `bugs/BUG-001/screenshot.png`, `bugs/BUG-001/trace.zip`

## BUG-002: Nút Lưu lệch trên mobile
- **Mức độ:** trivial · **Ưu tiên:** Low · **Trạng thái:** Vẫn còn
- **TC:** — · **REQ:** —
- **Jira:** APP-12

**Các bước tái hiện:**
1. Mở /profile ở 375px

**Kỳ vọng:** Nút Lưu nằm trong khung
**Thực tế:** Nút Lưu tràn ra ngoài
**Bằng chứng:** `bugs/BUG-002/screenshot.png`

## BUG-003: Tìm kiếm không ra kết quả
- **Mức độ:** Major · **Ưu tiên:** High · **Trạng thái:** Đã sửa
- **TC:** TC-010 · **REQ:** REQ-003
- **Jira:**

**Các bước tái hiện:**
1. Gõ "abc" vào ô tìm kiếm

**Kỳ vọng:** Có kết quả
**Thực tế:** Trống
