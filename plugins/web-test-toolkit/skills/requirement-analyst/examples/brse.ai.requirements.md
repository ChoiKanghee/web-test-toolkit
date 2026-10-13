# Phân tích requirement — brse.ai
> **Duyệt:** ⬜ Chờ duyệt

> **Việc của bạn trước khi duyệt (G1)**
> - Trả lời hoặc chuyển cho PO câu hỏi về khoá tài khoản (REQ-005).
> - Kiểm 2 mục "Chấp nhận tạm" (REQ-001, REQ-002): đúng là hành vi mong muốn chưa.
> - Không có tài liệu: mọi REQ đều từ chuẩn chung hoặc suy luận.

> Phân tích từ trang `https://brse.ai` (không có tài liệu requirement).

## Nguồn
| Tài liệu | Phiên bản / ngày | Ghi chú |
|---|---|---|
| (không có) | — | Chỉ khảo sát được phần công khai: chưa có tài khoản test |

## Requirement
| REQ | Nhóm | Mô tả | Nguồn | Trạng thái | Xác nhận bởi |
|---|---|---|---|---|---|
| REQ-001 | Truy cập | Mở `/` khi chưa đăng nhập thì chuyển tới trang đăng nhập | Suy luận | Chấp nhận tạm | — |
| REQ-002 | Đăng nhập | Trang đăng nhập có ô Email, ô Password, nút "Sign in"; ô nhập giữ giá trị vừa gõ | Suy luận | Chấp nhận tạm | — |
| REQ-003 | Đăng nhập | Đăng nhập sai không vào được bên trong | Chuẩn chung | Đã xác nhận | QA |
| REQ-004 | Chung | Trang tải không có lỗi JS, HTTP < 400 | Chuẩn chung | Đã xác nhận | QA |
| REQ-005 | Đăng nhập | Sai mật khẩu nhiều lần liên tiếp thì khoá tạm tài khoản | Suy luận | Cần hỏi | — |

## Luồng nghiệp vụ
### LUỒNG-01: Đăng nhập
1. Mở trang (REQ-001) → 2. Điền form (REQ-002) → 3. Gửi, bị từ chối nếu sai (REQ-003, REQ-005)

## Câu hỏi cần làm rõ
| # | REQ | Câu hỏi | Hỏi ai | Trả lời |
|---|---|---|---|---|
| 1 | REQ-005 | Có khoá tài khoản sau N lần sai không? N và thời gian khoá? | PO | |

## Phạm vi
- Trong phạm vi: phần công khai (trang đăng nhập).
- Ngoài phạm vi (và lý do): mọi chức năng sau đăng nhập — chưa có tài khoản test.
