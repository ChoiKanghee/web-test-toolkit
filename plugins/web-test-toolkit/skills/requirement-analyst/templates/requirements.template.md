# Phân tích requirement — <SITE>
> **Duyệt:** ⬜ Chờ duyệt

> **Việc của bạn trước khi duyệt (G1)**
> - <vd: Trả lời hoặc chuyển cho PO 3 câu hỏi ở mục "Câu hỏi cần làm rõ">
> - <vd: Kiểm 6 mục "Chấp nhận tạm" — hành vi hiện tại có đúng là hành vi mong muốn không>
> - <vd: Xem 2 chức năng có trong tài liệu nhưng không thấy trên trang>

> Phân tích từ các tài liệu ở mục "Nguồn" và trang `<URL>` ngày <DATE>.
> Trạng thái: **Đã xác nhận** = có tài liệu hoặc là chuẩn chung · **Chấp nhận tạm** = suy luận
> từ hành vi hiển nhiên, là mốc hồi quy · **Cần hỏi** = quy tắc nghiệp vụ suy luận, chờ PO/BA ·
> **Bỏ** = không còn áp dụng (giữ dòng, không xoá).

## Nguồn
| Tài liệu | Phiên bản / ngày | Ghi chú |
|---|---|---|
| <vd: D:\docs\PRD.pdf> | <vd: v2.1, 2026-09-01> | <vd: chỉ có phần Đăng nhập, Đơn hàng> |

## Requirement
> Bảng này là "hợp đồng" với bước design: mỗi REQ `Đã xác nhận` hoặc `Chấp nhận tạm` phải có
> test case. **Sửa trực tiếp được.** Giữ nguyên mã REQ; REQ mới lấy mã sau mã lớn nhất.

| REQ | Nhóm | Mô tả | Nguồn | Trạng thái | Xác nhận bởi |
|---|---|---|---|---|---|
| REQ-001 | <vd: Đăng nhập> | <vd: Sai mật khẩu thì báo lỗi, không vào được> | <vd: PRD.pdf §3.1> | Đã xác nhận | <vd: PRD.pdf> |
| REQ-002 | <vd: Chung> | <vd: Không có lỗi JS khi tải trang> | Chuẩn chung | Đã xác nhận | QA |
| REQ-003 | <vd: Đơn hàng> | <vd: Tìm đơn theo mã đơn> | Suy luận | Chấp nhận tạm | — |
| REQ-004 | <vd: Đơn hàng> | <vd: Đơn dưới 500k tính phí ship 30k> | Suy luận | Cần hỏi | — |

## Luồng nghiệp vụ
### LUỒNG-01: <vd: Đặt hàng>
1. <vd: Chọn sản phẩm> (REQ-…) → 2. <vd: Giỏ hàng> (REQ-…) → 3. <vd: Thanh toán> (REQ-…)

## Câu hỏi cần làm rõ
| # | REQ | Câu hỏi | Hỏi ai | Trả lời |
|---|---|---|---|---|
| 1 | REQ-004 | <vd: Ngưỡng miễn phí ship là bao nhiêu?> | <vd: PO> | |

## Phạm vi
- Trong phạm vi: <…>
- Ngoài phạm vi (và lý do): <…>
