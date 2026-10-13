"""AI proposals on an imported test plan, and the tester's decisions on them.

Three kinds of information the AI adds to imported test cases:

1. case['execution']   How to run the case, without changing what it tests: navigation, locators, data to
                       generate, fixtures, how each expected result is checked. Lives in the plan only and is
                       approved with it (it is part of the plan hash).
2. case['proposals']   Edits to the content of an existing case (a concrete expected result, a missing step,
                       a precondition). The AI proposes; the tester accepts or rejects; write-changes puts
                       accepted edits into the workbook.
3. plan['proposed_cases']  Cases missing from the workbook, with full content. Same decision and write path.

Content changes reach the workbook only through a tester decision, and the plan cannot be approved while a
proposal is still undecided or accepted but not yet written: the workbook stays the source of truth.
"""

import re
from datetime import datetime, timezone
from typing import Optional

from wtt.plan import (AUTOMATION_VALUES, ERROR, INFO, PRIORITIES, TEST_ID_PATTERN, WARNING, _issue, decision_mark,
                      split_numbered)

EDITABLE_FIELDS = ("title", "category", "preconditions", "steps", "test_data", "expected", "priority")
LIST_FIELDS = ("preconditions", "steps", "expected")
SOURCES = ("document", "site", "inference")
STATUSES = ("proposed", "accepted", "rejected")
EXECUTION_KEYS = ("navigation", "locators", "data", "fixtures", "checks", "notes")
NEW_CASE_FIELDS = ("id", "category", "title", "preconditions", "steps", "test_data", "expected", "priority",
                   "automation", "review", "execution", "reason", "source", "evidence", "status")

FIELD_LABELS = {
    "title": "Title", "category": "Category", "preconditions": "Pre-condition", "steps": "Steps",
    "test_data": "Test Data", "expected": "Expected Result", "priority": "Priority",
}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def as_list(value) -> list:
    """A list field as items: a list stays a list, text is split on '1. ... 2. ...' lines."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return split_numbered(str(value))


def current_value(case: dict, field: str):
    if field == "test_data":
        return (case.get("test_data") or {}).get("text")
    if field in LIST_FIELDS:
        return case.get(field) or []
    return case.get(field)


def normalized(field: str, value):
    if field in LIST_FIELDS:
        return as_list(value)
    if value is None:
        return None
    text = str(value).strip()
    return text.lower() if field == "priority" else (text or None)


# ========= Handles =========

def edit_handle(case_id: str, index: int) -> str:
    return f"{case_id}#{index + 1}"


_HANDLE = re.compile(r"^(?P<id>[A-Za-z][A-Za-z0-9]*_TC\d{3})(?:#(?P<n>\d+))?$")


def iter_proposals(plan: dict):
    """(handle, kind, case_or_None, proposal) for every proposal, edits first."""
    for case in plan.get("test_cases") or []:
        for index, proposal in enumerate(case.get("proposals") or []):
            yield edit_handle(case["id"], index), "edit", case, proposal
    for proposal in plan.get("proposed_cases") or []:
        yield proposal.get("id"), "new_case", None, proposal


def find(plan: dict, handle: str):
    match = _HANDLE.match(handle or "")
    if not match:
        raise ValueError(f"'{handle}' không phải mã đề xuất (dạng <TC ID>#<n> cho sửa case, <TC ID> cho case mới).")
    for found_handle, kind, case, proposal in iter_proposals(plan):
        if found_handle == handle:
            return kind, case, proposal
    if match.group("n") is None and any(case["id"] == handle for case in plan.get("test_cases") or []):
        raise ValueError(f"{handle} là case đã có: đề xuất sửa case dùng mã {handle}#<n>.")
    raise ValueError(f"Không có đề xuất '{handle}'.")


# ========= Checks =========

def _source_issues(proposal: dict) -> list:
    issues = []
    if not proposal.get("reason"):
        issues.append(_issue(ERROR, "proposal_reason", "Thiếu 'reason': vì sao đề xuất."))
    source = proposal.get("source")
    if source not in SOURCES:
        issues.append(_issue(ERROR, "proposal_source", f"'source' phải là {' / '.join(SOURCES)}."))
    elif source in ("document", "site") and not proposal.get("evidence"):
        issues.append(_issue(ERROR, "proposal_evidence",
                             "Thiếu 'evidence': tài liệu và vị trí (source document) hoặc URL / bước quan sát (site)."))
    if proposal.get("status", "proposed") not in STATUSES:
        issues.append(_issue(ERROR, "proposal_status", f"'status' phải là {' / '.join(STATUSES)}."))
    return issues


def _check_edit(case: dict, proposal: dict) -> list:
    issues = _source_issues(proposal)
    field = proposal.get("field")
    if field not in EDITABLE_FIELDS:
        issues.append(_issue(ERROR, "proposal_field", f"'field' phải là một trong: {', '.join(EDITABLE_FIELDS)}."))
        return issues
    value = normalized(field, proposal.get("value"))
    if not value:
        issues.append(_issue(ERROR, "proposal_value", "Thiếu 'value': nội dung mới."))
        return issues
    if field == "priority" and value not in PRIORITIES:
        issues.append(_issue(ERROR, "proposal_priority", f"Priority '{value}' không hợp lệ (High / Medium / Low)."))
    if value == normalized(field, current_value(case, field)):
        issues.append(_issue(WARNING, "proposal_no_change", "Nội dung đề xuất giống hệt nội dung hiện tại."))
    if field == "expected" and proposal.get("source") == "site":
        issues.append(_issue(INFO, "proposal_observed",
                             "Giá trị quan sát từ site: chỉ cho biết site đang chạy như vậy, tester cần xác nhận "
                             "đó là hành vi đúng."))
    return issues


def _check_new_case(plan: dict, proposal: dict, existing_ids: set, gaps: set, proposed_ids: list) -> list:
    issues = _source_issues(proposal)
    case_id = proposal.get("id") or ""
    function = (plan.get("function") or {}).get("name")
    match = TEST_ID_PATTERN.match(case_id)
    if not match:
        issues.append(_issue(ERROR, "new_id_format", f"Mã '{case_id}' không theo dạng <Function>_TC<NNN>."))
    elif function and match.group("function") != function:
        issues.append(_issue(ERROR, "new_id_function", f"Mã '{case_id}' không thuộc chức năng '{function}'."))
    if case_id in existing_ids:
        issues.append(_issue(ERROR, "new_id_exists", f"Mã '{case_id}' đã có trong workbook."))
    if case_id in gaps:
        issues.append(_issue(ERROR, "new_id_reused",
                             f"Mã '{case_id}' là mã đã bỏ trong dãy số: không dùng lại, lấy mã sau mã lớn nhất."))
    if proposed_ids.count(case_id) > 1:
        issues.append(_issue(ERROR, "new_id_duplicate", f"Mã '{case_id}' bị trùng giữa các case đề xuất."))
    for name in ("category", "title"):
        if not proposal.get(name):
            issues.append(_issue(ERROR, f"new_missing_{name}", f"Thiếu {FIELD_LABELS[name]}."))
    for name in ("steps", "expected"):
        if not as_list(proposal.get(name)):
            issues.append(_issue(ERROR, f"new_missing_{name}", f"Thiếu {FIELD_LABELS[name]}."))
    priority = normalized("priority", proposal.get("priority"))
    if priority not in PRIORITIES:
        issues.append(_issue(ERROR, "new_priority", f"Priority '{proposal.get('priority')}' không hợp lệ (High / Medium / Low)."))
    automation = proposal.get("automation")
    if automation is not None and automation not in AUTOMATION_VALUES:
        issues.append(_issue(ERROR, "new_automation", f"automation '{automation}' không hợp lệ ({', '.join(AUTOMATION_VALUES)})."))
    categories = (plan.get("function") or {}).get("categories") or []
    if proposal.get("category") and categories and proposal["category"] not in categories:
        issues.append(_issue(WARNING, "new_category",
                             f"Category '{proposal['category']}' chưa có trong sheet ({', '.join(categories)})."))
    unknown = [key for key in proposal if key not in NEW_CASE_FIELDS + ("decided", "written", "issues")]
    if unknown:
        issues.append(_issue(WARNING, "new_unknown_field", f"Trường không dùng tới: {', '.join(unknown)}."))
    return issues


def _check_execution(case: dict) -> list:
    execution = case.get("execution")
    if execution is None:
        return []
    if not isinstance(execution, dict):
        return [_issue(ERROR, "execution_format", "'execution' phải là mapping (navigation, locators, data, ...).")]
    unknown = [key for key in execution if key not in EXECUTION_KEYS]
    if unknown:
        return [_issue(WARNING, "execution_unknown_key",
                       f"'execution' có khóa lạ: {', '.join(unknown)} (dùng: {', '.join(EXECUTION_KEYS)}).")]
    return []


def check(plan: dict) -> None:
    """Recompute the 'issues' of every proposal and add execution / proposal issues to the cases."""
    cases = plan.get("test_cases") or []
    existing_ids = {case.get("id") for case in cases}
    numbers = sorted(int(m.group("number")) for case_id in existing_ids if (m := TEST_ID_PATTERN.match(case_id or "")))
    function = (plan.get("function") or {}).get("name")
    gaps = {f"{function}_TC{n:03d}" for n in range(numbers[0], numbers[-1] + 1) if n not in numbers} if numbers else set()
    for case in cases:
        case["issues"].extend(_check_execution(case))
        for proposal in case.get("proposals") or []:
            proposal["issues"] = _check_edit(case, proposal)
    new_cases = plan.get("proposed_cases") or []
    proposed_ids = [proposal.get("id") for proposal in new_cases]
    for proposal in new_cases:
        proposal["issues"] = _check_new_case(plan, proposal, existing_ids, gaps, proposed_ids) + _check_execution(proposal)


def counts(plan: dict) -> dict:
    result = {"edit": {}, "new_case": {}}
    for _, kind, _, proposal in iter_proposals(plan):
        state = "written" if proposal.get("written") else proposal.get("status") or "proposed"
        result[kind][state] = result[kind].get(state, 0) + 1
    return result


def blockers(plan: dict) -> list:
    """Proposals that keep the plan from approval: undecided, or accepted but not written yet."""
    found = []
    for handle, kind, _, proposal in iter_proposals(plan):
        if proposal.get("written"):
            continue
        status = proposal.get("status") or "proposed"
        label = "case mới" if kind == "new_case" else "đề xuất sửa"
        if status == "proposed":
            found.append(f"{handle} ({label}): tester chưa quyết định (decide --accept / --reject).")
        elif status == "accepted":
            found.append(f"{handle} ({label}): đã chấp nhận nhưng chưa ghi vào workbook (write-changes, rồi import lại).")
    return found


def next_free_id(plan: dict) -> Optional[str]:
    """First id after every existing and proposed number: deleted numbers in a gap are never reused."""
    function = (plan.get("function") or {}).get("name")
    if not function:
        return None
    ids = [case.get("id") for case in plan.get("test_cases") or []]
    ids += [proposal.get("id") for proposal in plan.get("proposed_cases") or []]
    numbers = [int(m.group("number")) for case_id in ids if (m := TEST_ID_PATTERN.match(case_id or ""))]
    return f"{function}_TC{(max(numbers) if numbers else 0) + 1:03d}"


# ========= Tester decisions =========

def decide(plan: dict, handles: list, accept: bool, by: str, note: Optional[str] = None,
           at: Optional[str] = None) -> list:
    """Accept or reject proposals. handles == ['all'] takes every proposal still undecided."""
    if not by or not by.strip():
        raise ValueError("Cần tên tester quyết định (--by).")
    if handles == ["all"]:
        targets = [(handle, kind, proposal) for handle, kind, _, proposal in iter_proposals(plan)
                   if (proposal.get("status") or "proposed") == "proposed" and not proposal.get("written")]
        if not targets:
            raise ValueError("Không còn đề xuất nào chờ quyết định.")
    else:
        targets = []
        for handle in handles:
            kind, _, proposal = find(plan, handle)
            targets.append((handle, kind, proposal))

    problems = []
    for handle, kind, proposal in targets:
        if proposal.get("written"):
            problems.append(f"{handle}: đã ghi vào workbook, không đổi quyết định được nữa.")
        elif accept and any(issue["severity"] == ERROR for issue in proposal.get("issues") or []):
            errors = " ".join(issue["message"] for issue in proposal["issues"] if issue["severity"] == ERROR)
            problems.append(f"{handle}: còn lỗi, chưa chấp nhận được: {errors}")
    if problems:
        raise ValueError("Không quyết định được:\n  - " + "\n  - ".join(problems))

    decided = {"by": by.strip(), "at": at or _now()}
    if note:
        decided["note"] = note
    for handle, kind, proposal in targets:
        proposal["status"] = "accepted" if accept else "rejected"
        proposal["decided"] = dict(decided)
    return [handle for handle, _, _ in targets]


# ========= What write-changes puts in the workbook =========

def pending_writes(plan: dict) -> tuple:
    """(edits, new_cases) accepted and not written yet.

    edits: [(handle, case_id, field, value, proposal)], several edits of one field: the last one wins.
    new_cases: [proposal]
    """
    edits, new_cases = [], []
    for handle, kind, case, proposal in iter_proposals(plan):
        if proposal.get("status") != "accepted" or proposal.get("written"):
            continue
        if kind == "edit":
            edits.append((handle, case["id"], proposal["field"], normalized(proposal["field"], proposal["value"]), proposal))
        else:
            new_cases.append(proposal)
    return edits, new_cases


def new_case_values(proposal: dict) -> dict:
    """Workbook field -> value for a proposed case (lists stay lists; the writer formats them)."""
    return {
        "id": proposal["id"],
        "category": proposal.get("category"),
        "title": proposal.get("title"),
        "precondition": as_list(proposal.get("preconditions")),
        "steps": as_list(proposal.get("steps")),
        "test_data": normalized("test_data", proposal.get("test_data")),
        "expected": as_list(proposal.get("expected")),
        "priority": normalized("priority", proposal.get("priority")),
        "automation_mark": decision_mark(proposal.get("automation")),
    }


def mark_written(proposals: list, file_name: str, at: Optional[str] = None) -> None:
    stamp = {"file": file_name, "at": at or _now()}
    for proposal in proposals:
        proposal["written"] = dict(stamp)


# ========= Re-import =========

def carry_over(new_plan: dict, old_plan: Optional[dict]) -> list:
    """Keep what is still open from the previous plan after a re-import.

    - Unwritten edit proposals stay on their case (decided ones keep their decision); written ones are gone:
      their content is in the workbook now.
    - Unwritten proposed cases stay unless the workbook now has that id. A proposed case that was written and
      is now in the workbook passes its automation decision, review and execution to the imported case.
    Returns the ids of imported cases that came from a proposed case.
    """
    if not old_plan:
        return []
    old_cases = {case.get("id"): case for case in old_plan.get("test_cases") or []}
    old_new = {proposal.get("id"): proposal for proposal in old_plan.get("proposed_cases") or []}
    landed = []
    for case in new_plan["test_cases"]:
        old = old_cases.get(case["id"])
        if old:
            kept = [proposal for proposal in old.get("proposals") or [] if not proposal.get("written")]
            if kept:
                case["proposals"] = kept
            continue
        proposed = old_new.get(case["id"])
        if proposed and proposed.get("written"):
            if case.get("automation") is None:
                case["automation"] = proposed.get("automation")
                case["review"] = proposed.get("review")
            if proposed.get("execution") is not None:
                case["execution"] = proposed["execution"]
            landed.append(case["id"])
    existing = {case["id"] for case in new_plan["test_cases"]}
    remaining = [proposal for proposal in old_new.values() if not proposal.get("written") and proposal.get("id") not in existing]
    if remaining:
        new_plan["proposed_cases"] = remaining
    return landed
