"""Render the tester-facing review page (import-review.md) from a plan."""

from wtt import proposals as P
from wtt.plan import (AUTOMATED, AUTOMATION_VALUES, ERROR, INFO, NOT_AUTOMATED, WARNING, approval_blockers,
                      approval_state, decision_mark)

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
    if isinstance(text, list):
        text = "\n".join(f"{index}. {item}" for index, item in enumerate(text, start=1))
    return (str(text) if text is not None else "").replace("|", "\\|").replace("\n", "<br>")


_PROPOSAL_STATE = {"proposed": "⏳ chờ tester", "accepted": "✅ chấp nhận, chưa ghi", "rejected": "✖ từ chối"}


def _proposal_state(proposal: dict) -> str:
    if proposal.get("written"):
        return f"📝 đã ghi vào {proposal['written'].get('file')}"
    state = _PROPOSAL_STATE.get(proposal.get("status") or "proposed", proposal.get("status"))
    decided = proposal.get("decided") or {}
    return f"{state} ({decided['by']})" if decided.get("by") and proposal.get("status") != "proposed" else state


def _proposal_issues(proposal: dict) -> str:
    return "<br>".join(f"{_SEVERITY_LABEL[issue['severity']]}: {_cell(issue['message'])}"
                       for issue in proposal.get("issues") or [])


def _execution_cell(value) -> str:
    if isinstance(value, dict):
        return "<br>".join(f"{_cell(key)}: {_cell(item)}" for key, item in value.items())
    if isinstance(value, list):
        return "<br>".join(f"- {_cell(item)}" for item in value)
    return _cell(value)


def _render_execution(plan: dict, add) -> None:
    """What the AI wrote on how to run each case: approved with the plan, so the tester must see all of it."""
    cases = [case for case in plan["test_cases"] if case.get("execution")]
    if not cases:
        return
    add("## Thông tin chạy do AI ghi (duyệt cùng plan)")
    add("")
    add("Cách sinh code sẽ chạy từng case. Phần này nằm trong nội dung được duyệt: sửa sau khi duyệt làm mất hiệu lực")
    add("bản duyệt. Không đổi những gì case kiểm tra; muốn đổi nội dung case thì phải qua đề xuất.")
    add("")
    add("| Case | " + " | ".join(_EXECUTION_LABEL[key] for key in P.EXECUTION_KEYS) + " | Khác |")
    add("|---|" + "---|" * (len(P.EXECUTION_KEYS) + 1))
    for case in cases:
        execution = case["execution"]
        if not isinstance(execution, dict):
            add(f"| {case['id']} | " + " | ".join("" for _ in P.EXECUTION_KEYS) + f" | {_execution_cell(execution)} |")
            continue
        others = {key: value for key, value in execution.items() if key not in P.EXECUTION_KEYS}
        add(f"| {case['id']} | " + " | ".join(_execution_cell(execution.get(key)) for key in P.EXECUTION_KEYS)
            + f" | {_execution_cell(others) if others else ''} |")
    add("")


_EXECUTION_LABEL = {"navigation": "Điều hướng", "locators": "Locator", "data": "Data", "fixtures": "Fixture",
                    "checks": "Cách kiểm Expected", "notes": "Ghi chú"}


def _render_proposals(plan: dict, add) -> None:
    edits = [(handle, case, proposal) for handle, kind, case, proposal in P.iter_proposals(plan) if kind == "edit"]
    new_cases = plan.get("proposed_cases") or []
    if not edits and not new_cases:
        return
    add("## Đề xuất của AI (tester quyết định)")
    add("")
    add("Nội dung test chỉ đổi khi tester chấp nhận. Đề xuất được chấp nhận được ghi vào workbook bằng `write-changes`,")
    add("kèm một dòng ở cột Note để team biết phần nào đến từ AI. Nguồn `site` chỉ cho biết site *đang* chạy như vậy.")
    add("")
    if edits:
        add("### Sửa case đã có")
        add("")
        add("| Mã đề xuất | Trường | Hiện tại | Đề xuất | Nguồn | Lý do | Trạng thái | Kiểm tra |")
        add("|---|---|---|---|---|---|---|---|")
        for handle, case, proposal in edits:
            field = proposal.get("field")
            current = P.current_value(case, field) if field in P.EDITABLE_FIELDS else None
            source = f"{proposal.get('source')}: {proposal.get('evidence')}" if proposal.get("evidence") else proposal.get("source")
            add(f"| {handle} | {P.FIELD_LABELS.get(field, field)} | {_cell(current)} | {_cell(proposal.get('value'))} | "
                f"{_cell(source)} | {_cell(proposal.get('reason'))} | {_proposal_state(proposal)} | {_proposal_issues(proposal)} |")
        add("")
    if new_cases:
        add("### Case mới")
        add("")
        add("| Mã | Category | Title | Pre-condition | Steps | Expected | Priority | Automation | Nguồn | Lý do | Trạng thái | Kiểm tra |")
        add("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for proposal in new_cases:
            source = f"{proposal.get('source')}: {proposal.get('evidence')}" if proposal.get("evidence") else proposal.get("source")
            add(f"| {proposal.get('id')} | {_cell(proposal.get('category'))} | {_cell(proposal.get('title'))} | "
                f"{_cell(proposal.get('preconditions'))} | {_cell(proposal.get('steps'))} | {_cell(proposal.get('expected'))} | "
                f"{proposal.get('priority')} | {proposal.get('automation') or '—'} | {_cell(source)} | "
                f"{_cell(proposal.get('reason'))} | {_proposal_state(proposal)} | {_proposal_issues(proposal)} |")
        add("")


def render_review(plan: dict, approval: tuple = None) -> str:
    """The tester's review page. approval: (state, message) from the gate check, when the caller has it."""
    source = plan["source"]
    function = plan["function"]
    summary = plan["summary"]
    state, state_message = approval or approval_state(plan)
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
    ticks = summary.get("by_workbook_automation") or {}
    add("| Cột Automation trong workbook (lúc import) | Số case |")
    add("|---|---|")
    for key, label in ((AUTOMATED, AUTOMATED), (NOT_AUTOMATED, NOT_AUTOMATED), ("none", "(trống)")):
        if ticks.get(key):
            add(f"| {label} | {ticks[key]} |")
    for key, number in ticks.items():
        if key not in (AUTOMATED, NOT_AUTOMATED, "none"):
            add(f"| {_cell(key)} (giá trị lạ) | {number} |")
    add("")
    states = summary.get("by_execution_state") or {}
    if states:
        add("| Trạng thái thực hiện (1回目 → 2回目 → 3回目) | Số case |")
        add("|---|---|")
        for key, label in _STATE_LABEL.items():
            if states.get(key):
                add(f"| {label} | {states[key]} |")
        add("")
    add(f"Có thông tin chạy (`execution`: điều hướng, locator, data, fixture): **{summary.get('with_execution', 0)}** / "
        f"{summary['total']} case.")
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

    _render_proposals(plan, add)
    _render_execution(plan, add)

    add("## Quyết định automation")
    add("")
    add("Cột **Workbook** là giá trị cột Automation lúc import; cột **Sẽ ghi** là giá trị `write-automation` ghi vào")
    add("workbook sau khi duyệt (auto / partial → Automated, manual / need_info → Not Automated). Chỉ case Automated")
    add("được sinh test và chạy ở bước execute.")
    add("")
    add("| Case | Title | Priority | Workbook | Automation | Sẽ ghi | Lý do / ghi chú |")
    add("|---|---|---|---|---|---|---|")
    for case in plan["test_cases"]:
        automation = case.get("automation") or "none"
        tick = decision_mark(case.get("automation")) or "—"
        before = case.get("workbook_automation") or "—"
        changed = " ✏️" if case.get("workbook_automation") and tick not in ("—", case.get("workbook_automation")) else ""
        add(f"| {case['id']} | {_cell(case.get('title'))} | {case.get('priority')} | {_cell(before)} | {automation} | "
            f"{tick}{changed} | {_cell(case.get('review'))} |")
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
        add("   Đề xuất của AI: tester tự chạy `decide <mã> --accept|--reject --by <tên>` trong terminal, rồi `write-changes`")
        add("   ghi phần chấp nhận vào")
        add("   workbook và import lại file vừa ghi.")
        add("2. Kiểm tra cột automation và lý do của từng case, và phần thông tin chạy do AI ghi; sửa trực tiếp trong")
        add("   `test-plan.yaml` nếu không đồng ý.")
        add("3. Khi đồng ý, tự chạy lệnh duyệt trong terminal (`approve --by <tên>`, gõ tên chức năng để xác nhận).")
        add("   Sửa plan sau khi duyệt sẽ làm mất hiệu lực bản duyệt.")
        add("4. Sau khi duyệt, `write-automation` ghi dấu Automated / Not Automated vào cột Automation của workbook.")
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
