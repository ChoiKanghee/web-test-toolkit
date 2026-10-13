"""Render the tester-facing review page (import-review.md) from a plan."""

from wtt.plan import AUTOMATION_VALUES, ERROR, INFO, WARNING, approval_blockers, approval_state

_SEVERITY_LABEL = {ERROR: "❌ Lỗi", WARNING: "⚠️ Cần xem", INFO: "ℹ️ Ghi chú"}
_STATE_LABEL = {
    "not_run": "Chưa chạy (sẽ ghi vào 1回目)",
    "in_progress": "Đang chạy dở",
    "retest": "Cần retest (Failed/Blocked, ghi vào lần tiếp theo)",
    "passed": "Đã Passed",
    "not_applicable": "N/A",
    "no_round_left": "Hết lần retest mà chưa Passed",
    "unknown": "Không xác định",
}
_AUTOMATION_LABEL = {
    "auto": "auto — tự động hóa trọn vẹn",
    "partial": "partial — tự động phần kiểm tra được, phần còn lại người duyệt",
    "manual": "manual — chạy tay",
    "need_info": "need_info — cần bổ sung thông tin trước",
    "none": "chưa review",
}


def _cell(text) -> str:
    return (str(text) if text is not None else "").replace("|", "\\|").replace("\n", "<br>")


def render_review(plan: dict) -> str:
    source = plan["source"]
    function = plan["function"]
    summary = plan["summary"]
    state, state_message = approval_state(plan)
    lines = []
    add = lines.append

    add(f"# Review import test case — {function.get('display_name') or function.get('name')}")
    add("")
    add(f"- Nguồn: `{source['file']}` / sheet `{source['sheet']}` (import lúc {source['imported_at']})")
    add(f"- Chức năng: `{function.get('name')}` — module `{function.get('module')}` — môi trường: {function.get('environment')}")
    add(f"- Trạng thái duyệt: **{state_message}**")
    add("")
    add("## Tổng quan")
    add("")
    add(f"Tổng số case: **{summary['total']}**. Vấn đề: {summary['issues'][ERROR]} lỗi, "
        f"{summary['issues'][WARNING]} cần xem, {summary['issues'][INFO]} ghi chú.")
    add("")
    add("| Category | Số case |")
    add("|---|---|")
    for category, number in summary["by_category"].items():
        add(f"| {_cell(category)} | {number} |")
    add("")
    add("| Priority | Số case |")
    add("|---|---|")
    for priority in ("high", "medium", "low", "none"):
        if priority in summary["by_priority"]:
            add(f"| {priority} | {summary['by_priority'][priority]} |")
    add("")
    add("| Automation | Số case |")
    add("|---|---|")
    for key in (*AUTOMATION_VALUES, "none"):
        if key in summary["by_automation"]:
            add(f"| {_AUTOMATION_LABEL[key]} | {summary['by_automation'][key]} |")
    add("")
    states = summary.get("by_execution_state") or {}
    if states:
        add("| Trạng thái thực hiện (1回目 → 2回目 → 3回目) | Số case |")
        add("|---|---|")
        for key, label in _STATE_LABEL.items():
            if states.get(key):
                add(f"| {label} | {states[key]} |")
        add("")
    if summary["id_gaps"]:
        add(f"Mã bị bỏ trống trong dãy số (đúng quy ước không dùng lại mã đã xóa): {', '.join(summary['id_gaps'])}.")
        add("")

    if summary["data_not_ready"]:
        add("## Test data chưa sẵn sàng")
        add("")
        add("| Mã | Nội dung | Ghi chú | Dùng ở |")
        add("|---|---|---|---|")
        for data_id in summary["data_not_ready"]:
            item = plan["test_data"][data_id]
            add(f"| {data_id} | {_cell(item.get('content'))} | {_cell(item.get('note'))} | {_cell(', '.join(item.get('used_in') or []))} |")
        add("")

    flagged = [case for case in plan["test_cases"] if case["issues"]]
    add("## Vấn đề theo từng case")
    add("")
    if not flagged:
        add("Không có vấn đề nào được phát hiện tự động.")
    else:
        add("| Case | Category | Mức | Vấn đề |")
        add("|---|---|---|---|")
        for case in flagged:
            for issue in sorted(case["issues"], key=lambda item: (ERROR, WARNING, INFO).index(item["severity"])):
                add(f"| {case['id']} | {_cell(case.get('category'))} | {_SEVERITY_LABEL[issue['severity']]} | {_cell(issue['message'])} |")
    add("")

    add("## Quyết định automation")
    add("")
    add("| Case | Title | Priority | Automation | Lý do / ghi chú |")
    add("|---|---|---|---|---|")
    for case in plan["test_cases"]:
        automation = case.get("automation") or "none"
        add(f"| {case['id']} | {_cell(case.get('title'))} | {case.get('priority')} | {automation} | {_cell(case.get('review'))} |")
    add("")

    dependencies = [case for case in plan["test_cases"] if case.get("depends_on")]
    if dependencies:
        add("## Phụ thuộc giữa các case")
        add("")
        add("Khi sinh code, phần chuẩn bị chung sẽ thành fixture thay vì để test này phụ thuộc kết quả test kia.")
        add("")
        for case in dependencies:
            add(f"- {case['id']} cần trạng thái của {', '.join(case['depends_on'])}")
        add("")

    add("## Duyệt (gate)")
    add("")
    blockers = approval_blockers(plan)
    if state == "approved":
        add(f"✅ {state_message}")
    else:
        add("Việc của tester trước khi duyệt:")
        add("")
        add("1. Đọc các case có ❌ và ⚠️: sửa trong file Excel rồi import lại, hoặc ghi quyết định vào `test-plan.yaml`.")
        add("2. Kiểm tra cột automation và lý do của từng case; sửa trực tiếp trong `test-plan.yaml` nếu không đồng ý.")
        add("3. Khi đồng ý, chạy lệnh duyệt (`approve --by <tên>`). Sửa plan sau khi duyệt sẽ làm mất hiệu lực bản duyệt.")
        add("")
        if blockers:
            add(f"Còn {len(blockers)} điểm chặn duyệt:")
            add("")
            for blocker in blockers[:50]:
                add(f"- {blocker}")
            if len(blockers) > 50:
                add(f"- ... và {len(blockers) - 50} điểm khác")
        else:
            add("Không còn điểm chặn: có thể duyệt.")
    add("")
    return "\n".join(lines)


def functions_yaml_snippet(plan: dict) -> str:
    """Entry for the framework's resources/functions.yaml."""
    function = plan["function"]
    lines = [f"  {function['name']}:", f"    name: {function.get('display_name') or function['name']}",
             f"    sheet: {plan['source']['sheet']}", "    categories:"]
    lines.extend(f"      - {category}" for category in function["categories"])
    return "\n".join(lines) + "\n"
