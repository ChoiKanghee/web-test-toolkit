"""Test plan: the single contract between test design / import and test generation.

A plan is a YAML file (artifacts/<Function>/test-plan.yaml). It comes from the
workbook import (or, later, from test design), is reviewed by the AI and the
tester, and is approved at the gate before any test code is generated.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

from wtt.workbook import RawSheet, RawWorkbook


SCHEMA_VERSION = 1

PRIORITIES = ("high", "medium", "low")
AUTOMATION_VALUES = ("auto", "partial", "manual", "need_info")
RUNNABLE = ("auto", "partial")

# The workbook's Automation column is the tick the team sees; the plan keeps the finer decision.
# auto / partial -> Automated (a script runs it); manual / need_info -> Not Automated.
AUTOMATED, NOT_AUTOMATED = "Automated", "Not Automated"
MARK_TO_DECISION = {AUTOMATED: "auto", NOT_AUTOMATED: "manual"}
TEMPLATE_STATUSES = ("Passed", "Failed", "Blocked", "In progress", "Todo", "N/A")

TEST_ID_PATTERN = re.compile(r"^(?P<function>[A-Za-z][A-Za-z0-9]*)_TC(?P<number>\d{3})$")
_NUMBERED_LINE = re.compile(r"^\s*(\d+)[.)]\s*(.*)$")

# Data marked as not ready in the TestData sheet note.
DATA_NOT_READY = re.compile(r"cần chuẩn bị|cần bổ sung|chưa có|要準備|未準備|\bTBD\b|\bTODO\b", re.IGNORECASE)
# Values written as examples, not concrete inputs (VI / JA / EN).
EXAMPLE_VALUE = re.compile(
    r"(^|[\s('\"（「])(vd|ví dụ|e\.g\.|eg\.|ex\.|for example)[\s.:：]"
    r"|例えば|例[:：]|（例）|\(例\)",
    re.IGNORECASE,
)
# Expected results that a script cannot check without a concrete value (VI / JA / EN).
# A first filter only: the AI review step is where vague expectations are judged.
VAGUE_EXPECTED = [
    re.compile(pattern, re.IGNORECASE) for pattern in (
        # Vietnamese
        r"đúng (nội dung )?thiết kế", r"đúng design", r"đúng spec", r"hợp lý", r"phù hợp", r"bất hợp lý",
        r"khớp (với )?(pdf|tài liệu|file)? ?nguồn", r"như mong đợi", r"bình thường",
        # Japanese
        r"デザイン通り", r"設計通り", r"仕様通り", r"想定通り", r"期待通り", r"適切", r"妥当", r"自然な", r"問題(が)?ない",
        # English
        r"as designed", r"as expected", r"matches the design", r"according to (the )?(design|spec)",
        r"appropriate", r"reasonable", r"\bproperly\b",
    )
]

ERROR, WARNING, INFO = "error", "warning", "info"


# ========= Text helpers =========

def split_numbered(text: Optional[str]) -> list:
    """'1. a\\n2. b\\n   more' -> ['a', 'b more']. Unnumbered text stays one item."""
    if not text:
        return []
    items = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        match = _NUMBERED_LINE.match(line)
        if match:
            items.append(match.group(2).strip())
        elif items:
            items[-1] = f"{items[-1]}\n{line}"
        else:
            items.append(line)
    return [item for item in items if item]


def data_ref_pattern(data_ids: list) -> Optional[re.Pattern]:
    if not data_ids:
        return None
    alternatives = "|".join(re.escape(data_id) for data_id in sorted(data_ids, key=len, reverse=True))
    return re.compile(rf"(?<![\w-])({alternatives})(?![\w-])")


_ID_LIKE = re.compile(r"(?<![\w-])((?:[A-Z]{2,}|Q)(?:-[A-Z0-9]+)*-?\d+[A-Z0-9-]*)(?![\w-])")


def normalize_mark(text: Optional[str]) -> Optional[str]:
    """'automated' -> 'Automated', 'not  automated' -> 'Not Automated'; other text is returned as is."""
    if not text:
        return None
    key = " ".join(text.replace("-", " ").split()).lower()
    return {"automated": AUTOMATED, "not automated": NOT_AUTOMATED}.get(key, text)


def decision_mark(automation: Optional[str]) -> Optional[str]:
    """The workbook tick for a plan decision (None while undecided)."""
    if automation in RUNNABLE:
        return AUTOMATED
    if automation in ("manual", "need_info"):
        return NOT_AUTOMATED
    return None


# ========= Build =========

def _test_data_section(raw: RawWorkbook) -> dict:
    data = {}
    for item in raw.test_data:
        values = item.values
        used_in = [part.strip() for part in re.split(r"[,、\n]", values.get("used_in") or "") if part.strip()]
        note = values.get("note")
        data[values["id"]] = {
            "type": values.get("type"),
            "content": values.get("content"),
            "language": values.get("language") if values.get("language") not in ("-", None) else None,
            "used_in": used_in,
            "note": note,
            "ready": not (note and DATA_NOT_READY.search(note)),
        }
    return data


# Result columns 1回目 / 2回目 / 3回目 are retest rounds, not browsers: every case runs in round 1;
# a case that Failed (or was Blocked) moves to the next round to be retested after the fix.
RETEST_STATUSES = ("Failed", "Blocked")
DONE_STATUSES = ("Passed", "N/A")
OPEN_STATUSES = ("Todo", "In progress")


def execution_state(runs: list) -> tuple:
    """(state, next_round) from the round cells. next_round is 1-based, None when nothing is left to run.

    state: not_run | in_progress | retest | passed | not_applicable | no_round_left
    """
    filled = [index for index, run in enumerate(runs) if run]
    if not filled:
        return "not_run", 1 if runs else None
    last = filled[-1]
    latest = runs[last]
    if latest in OPEN_STATUSES:
        return ("not_run" if last == 0 and latest == "Todo" else "in_progress"), last + 1
    if latest == "Passed":
        return "passed", None
    if latest == "N/A":
        return "not_applicable", None
    if latest in RETEST_STATUSES:
        return ("retest", last + 2) if last + 1 < len(runs) else ("no_round_left", None)
    return "unknown", None


def _history(raw_case, status_issues: list) -> dict:
    runs = [run for run in raw_case.runs]
    filled = [run for run in runs if run]
    for run in filled:
        if run not in TEMPLATE_STATUSES:
            status_issues.append(run)
    bug_ids = [part.strip() for part in re.split(r"[,、\s]+", raw_case.values.get("bug_id") or "") if part.strip()]
    state, next_round = execution_state(runs)
    return {
        "runs": runs,
        "latest": filled[-1] if filled else "Todo",
        "state": state,
        "next_round": next_round,
        "bug_ids": bug_ids,
        "tester": raw_case.values.get("tester"),
        "date": raw_case.values.get("date"),
        "note": raw_case.values.get("note"),
    }


def build_plan(raw: RawWorkbook, sheet: RawSheet, imported_at: Optional[str] = None) -> dict:
    """Convert one workbook sheet into a plan dict. Review fields start empty.

    The workbook's Automation column is kept in 'workbook_automation'; apply_workbook_marks() turns it
    into decisions (after merge_review() on a re-import), then analyse() again.
    """
    test_data = _test_data_section(raw)
    ref_pattern = data_ref_pattern(list(test_data))

    cases = []
    categories = []
    for raw_case in sheet.cases:
        values = raw_case.values
        category = values.get("category")
        if category and category not in categories:
            categories.append(category)

        test_data_text = values.get("test_data")
        refs = ref_pattern.findall(test_data_text) if (ref_pattern and test_data_text) else []

        status_issues = []
        case = {
            "id": values["id"],
            "category": category,
            "title": values.get("title"),
            "priority": (values.get("priority") or "").strip().lower() or None,
            "preconditions": split_numbered(values.get("precondition")),
            "steps": split_numbered(values.get("steps")),
            "test_data": {"text": test_data_text, "refs": list(dict.fromkeys(refs))},
            "expected": split_numbered(values.get("expected")),
            "history": _history(raw_case, status_issues),
            "source": {"sheet": sheet.name, "row": raw_case.row},
            "workbook_automation": normalize_mark(values.get("automation_mark")),
            "automation": None,
            "review": None,
            "issues": [],
        }
        if status_issues:
            case["_bad_statuses"] = status_issues
        cases.append(case)

    function_names = [m.group("function") for c in cases if (m := TEST_ID_PATTERN.match(c["id"] or ""))]
    function = max(set(function_names), key=function_names.count) if function_names else None

    plan = {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "type": "workbook",
            "file": raw.path.name,
            "sheet": sheet.name,
            "sha256": hashlib.sha256(raw.path.read_bytes()).hexdigest(),
            "imported_at": imported_at or datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        },
        "function": {
            "name": function,
            "display_name": sheet.meta.get("function_name"),
            "module": sheet.meta.get("module"),
            "environment": sheet.meta.get("environment"),
            "categories": categories,
        },
        "test_data": test_data,
        "test_cases": cases,
        "approval": None,
    }
    analyse(plan)
    for case in plan["test_cases"]:
        case.pop("_bad_statuses", None)
    return plan


# ========= Deterministic checks =========

def _issue(severity: str, code: str, message: str) -> dict:
    return {"severity": severity, "code": code, "message": message}


def analyse(plan: dict) -> dict:
    """Recompute every case's 'issues' and the plan-level 'summary' from the current content."""
    cases = plan["test_cases"]
    test_data = plan.get("test_data") or {}
    function = (plan.get("function") or {}).get("name")
    ids = [case.get("id") for case in cases]
    known_ids = set(ids)
    ref_pattern = data_ref_pattern(list(test_data))

    for case in cases:
        issues = []
        case_id = case.get("id") or ""
        match = TEST_ID_PATTERN.match(case_id)

        if not match:
            issues.append(_issue(ERROR, "id_format", f"Mã '{case_id}' không theo dạng <Function>_TC<NNN>."))
        elif function and match.group("function") != function:
            issues.append(_issue(ERROR, "id_function",
                                 f"Mã '{case_id}' có tên chức năng khác với các case còn lại ('{function}')."))
        if ids.count(case_id) > 1:
            issues.append(_issue(ERROR, "id_duplicate", f"Mã '{case_id}' bị trùng."))

        for name, label in (("category", "Category"), ("title", "Title")):
            if not case.get(name):
                issues.append(_issue(ERROR, f"missing_{name}", f"Thiếu {label} (cột bắt buộc)."))
        if not case.get("steps"):
            issues.append(_issue(ERROR, "missing_steps", "Thiếu Steps (cột bắt buộc): không có thao tác để tự động hóa."))
        if not case.get("expected"):
            issues.append(_issue(ERROR, "missing_expected", "Thiếu Expected Result (cột bắt buộc)."))

        priority = case.get("priority")
        if priority not in PRIORITIES:
            issues.append(_issue(ERROR, "priority", f"Priority '{priority}' không hợp lệ (High / Medium / Low)."))

        for status in case.pop("_bad_statuses", []) or []:
            issues.append(_issue(WARNING, "run_status", f"Kết quả chạy '{status}' không thuộc danh sách trạng thái của template."))

        data = case.get("test_data") or {}
        text = data.get("text") or ""
        refs = data.get("refs") or []
        for ref in refs:
            item = test_data.get(ref)
            if item is None:
                issues.append(_issue(ERROR, "data_unknown", f"Test data '{ref}' không có trong sheet TestData."))
            elif not item.get("ready", True):
                issues.append(_issue(WARNING, "data_not_ready",
                                     f"Test data '{ref}' chưa sẵn sàng: {item.get('note') or 'xem sheet TestData'}."))
        if text:
            known_refs = set(ref_pattern.findall(text)) if ref_pattern else set()
            for token in _ID_LIKE.findall(text):
                if token not in known_refs and token not in test_data and not TEST_ID_PATTERN.match(token):
                    issues.append(_issue(WARNING, "data_unknown_ref",
                                         f"Test data nhắc tới '{token}' nhưng không có mã này trong sheet TestData."))
            if EXAMPLE_VALUE.search(text):
                issues.append(_issue(WARNING, "data_example",
                                     "Test data chỉ là ví dụ ('vd ...'): cần chốt giá trị cụ thể cho automation."))

        for expected in case.get("expected") or []:
            for pattern in VAGUE_EXPECTED:
                found = pattern.search(expected)
                if found:
                    issues.append(_issue(WARNING, "vague_expected",
                                         f"Kỳ vọng chưa đo được bằng code ('{found.group(0)}'): \"{expected}\"."))
                    break

        mentioned = " ".join(case.get("preconditions") or []) + " " + " ".join(case.get("steps") or [])
        depends = sorted({other for other in re.findall(r"[A-Za-z][A-Za-z0-9]*_TC\d{3}", mentioned)
                          if other != case_id})
        case["depends_on"] = depends
        for other in depends:
            if other not in known_ids:
                issues.append(_issue(WARNING, "depends_unknown", f"Precondition nhắc tới '{other}' nhưng không có case này."))

        history = case.get("history") or {}
        runs = history.get("runs") or []
        filled_positions = [index for index, run in enumerate(runs) if run]
        if filled_positions and filled_positions != list(range(len(filled_positions))):
            issues.append(_issue(WARNING, "round_gap",
                                 "Cột kết quả bị nhảy cóc (có lần sau nhưng trống lần trước): kiểm tra lại 1回目/2回目/3回目."))
        for index, run in enumerate(runs[:-1]):
            later = [value for value in runs[index + 1:] if value]
            if run in DONE_STATUSES and later:
                issues.append(_issue(WARNING, "round_after_done",
                                     f"Lần {index + 1} đã {run} nhưng các lần sau vẫn có kết quả: retest chỉ dành cho case Failed/Blocked."))
                break
        if history.get("state") == "no_round_left":
            issues.append(_issue(WARNING, "no_round_left",
                                 f"Đã dùng hết {len(runs)} lần chạy mà vẫn {history.get('latest')}: không còn cột để ghi lần retest tiếp theo."))
        if history.get("latest") == "Failed" and not history.get("bug_ids"):
            issues.append(_issue(WARNING, "failed_without_bug", "Lần chạy gần nhất Failed nhưng chưa có Bug ID."))
        if any(run == "Failed" for run in history.get("runs") or []) and history.get("bug_ids"):
            issues.append(_issue(INFO, "known_bug",
                                 f"Từng Failed (bug {', '.join(history['bug_ids'])}): dùng làm case hồi quy cho bug này."))

        if case.get("automation") is not None and case["automation"] not in AUTOMATION_VALUES:
            issues.append(_issue(ERROR, "automation_value",
                                 f"automation '{case['automation']}' không hợp lệ ({', '.join(AUTOMATION_VALUES)})."))

        mark = case.get("workbook_automation")
        if mark and mark not in MARK_TO_DECISION:
            issues.append(_issue(WARNING, "workbook_automation_value",
                                 f"Cột Automation ghi '{mark}', không phải {AUTOMATED} / {NOT_AUTOMATED}: bỏ qua giá trị này."))
        elif mark and decision_mark(case.get("automation")) not in (None, mark):
            issues.append(_issue(WARNING, "workbook_automation_differs",
                                 f"Cột Automation trong workbook ghi '{mark}' nhưng plan quyết định "
                                 f"'{case['automation']}': sau khi duyệt, write-automation sẽ ghi "
                                 f"'{decision_mark(case['automation'])}' vào workbook."))

        case["issues"] = issues

    from wtt import proposals as _proposals  # late import: proposals builds on this module
    _proposals.check(plan)

    numbers = sorted(int(m.group("number")) for case_id in ids if (m := TEST_ID_PATTERN.match(case_id or "")))
    gaps = [n for n in range(numbers[0], numbers[-1] + 1) if n not in numbers] if numbers else []

    def count(key):
        result = {}
        for case in cases:
            value = case.get(key) or "none"
            result[value] = result.get(value, 0) + 1
        return result

    plan["summary"] = {
        "total": len(cases),
        "by_category": count("category"),
        "by_priority": count("priority"),
        "by_automation": count("automation"),
        "by_workbook_automation": count("workbook_automation"),
        "issues": {
            severity: sum(1 for case in cases for issue in case["issues"] if issue["severity"] == severity)
            for severity in (ERROR, WARNING, INFO)
        },
        "by_execution_state": {
            state: sum(1 for case in cases if (case.get("history") or {}).get("state") == state)
            for state in sorted({(case.get("history") or {}).get("state") or "unknown" for case in cases})
        },
        "id_gaps": [f"{function}_TC{n:03d}" for n in gaps] if function else [],
        "data_not_ready": sorted(data_id for data_id, item in test_data.items() if not item.get("ready", True)),
        "proposals": _proposals.counts(plan),
        "with_execution": sum(1 for case in cases if case.get("execution")),
    }
    return plan


# ========= Workbook Automation column -> decision =========

_NO_OLD_CASE = object()


def apply_workbook_marks(plan: dict, old_plan: Optional[dict] = None) -> list:
    """Let a tick in the workbook's Automation column set the plan decision.

    The tick wins when it is new or changed since the previous import (the tester decided in Excel)
    and the plan decision does not already agree with it. A tick that has not changed since the last
    import does not undo a later decision in the plan, and does not fill in a decision that a content
    change reset: the case is flagged instead (workbook_automation_differs) or must be reviewed again.
    auto / partial agree with Automated, manual / need_info with Not Automated, so a finer decision
    is kept. Returns the ids whose decision the tick set.
    """
    old_cases = {case.get("id"): case for case in (old_plan or {}).get("test_cases") or []}
    applied = []
    for case in plan["test_cases"]:
        mark = case.get("workbook_automation")
        if mark not in MARK_TO_DECISION:
            continue
        old = old_cases.get(case["id"], _NO_OLD_CASE)
        previous_mark = None if old is _NO_OLD_CASE else old.get("workbook_automation")
        if old is not _NO_OLD_CASE and previous_mark == mark:
            continue
        decision = case.get("automation")
        if decision_mark(decision) == mark:
            continue
        note = f"Theo cột Automation trong workbook: {mark}."
        earlier = []
        if decision:
            earlier.append(f"quyết định trước: {decision}")
        if case.get("review"):
            earlier.append(f"ghi chú trước: {case['review']}")
        case["automation"] = MARK_TO_DECISION[mark]
        case["review"] = f"{note} ({'; '.join(earlier)})" if earlier else note
        applied.append(case["id"])
    return applied


# ========= Re-import: keep review decisions =========

REVIEW_FIELDS = ("automation", "review", "execution")


def merge_review(new_plan: dict, old_plan: Optional[dict]) -> list:
    """Copy automation / review / execution from the previous plan into a re-imported plan.

    Unchanged cases keep their decisions. Changed cases keep the review text but their
    automation decision is reset, so the plan cannot be approved until they are reviewed again.
    Returns the ids of changed cases.
    """
    if not old_plan:
        return []
    old_cases = {case.get("id"): case for case in old_plan.get("test_cases") or []}
    changed = []
    for case in new_plan["test_cases"]:
        old = old_cases.get(case["id"])
        if not old:
            continue
        for name in REVIEW_FIELDS:
            case[name] = old.get(name)
        if _content(case) != _content(old):
            changed.append(case["id"])
            case["automation"] = None
    return changed


# ========= Approval gate =========

_CONTENT_FIELDS = ("id", "category", "title", "priority", "preconditions", "steps", "test_data", "expected",
                   "automation", "review", "execution", "depends_on")


def _content(case: dict) -> dict:
    return {name: case.get(name) for name in _CONTENT_FIELDS}


def content_hash(plan: dict) -> str:
    payload = {
        "function": plan.get("function"),
        "test_data": plan.get("test_data"),
        "test_cases": [_content(case) for case in plan.get("test_cases") or []],
    }
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def approval_blockers(plan: dict) -> list:
    """Reasons the plan cannot be approved yet."""
    blockers = []
    for case in plan["test_cases"]:
        automation = case.get("automation")
        if automation is None:
            blockers.append(f"{case['id']}: chưa có quyết định automation ({' / '.join(AUTOMATION_VALUES)}).")
            continue
        if automation not in AUTOMATION_VALUES:
            blockers.append(f"{case['id']}: automation '{automation}' không hợp lệ.")
            continue
        if automation in ("auto", "partial"):
            errors = [issue["message"] for issue in case["issues"] if issue["severity"] == ERROR]
            if errors:
                blockers.append(f"{case['id']} ({automation}) còn lỗi: {' '.join(errors)}")
        if automation in ("partial", "manual", "need_info") and not case.get("review"):
            blockers.append(f"{case['id']} ({automation}): cần ghi lý do vào 'review'.")
    from wtt import proposals as _proposals
    blockers.extend(_proposals.blockers(plan))
    return blockers


def workbook_marks(plan: dict) -> dict:
    """{test_id: tick} for every decided case: what write-automation puts in the Automation column."""
    return {case["id"]: decision_mark(case.get("automation")) for case in plan["test_cases"]
            if decision_mark(case.get("automation"))}


EXECUTION_SCOPES = ("all", "pending", "retest")


def execution_cases(plan: dict, scope: str = "all") -> list:
    """Cases the executor runs: decision auto / partial (ticked Automated), filtered by scope.

    all      every automated case (regression run)
    pending  automated cases still without a final result in the workbook: not run, in progress, retest
    retest   automated cases that Failed / Blocked and wait for the next round
    """
    if scope not in EXECUTION_SCOPES:
        raise ValueError(f"scope '{scope}' không hợp lệ ({', '.join(EXECUTION_SCOPES)}).")
    states = {"all": None, "pending": ("not_run", "in_progress", "retest"), "retest": ("retest",)}[scope]
    selected = []
    for case in plan["test_cases"]:
        if case.get("automation") not in RUNNABLE:
            continue
        if states and (case.get("history") or {}).get("state") not in states:
            continue
        selected.append(case)
    return selected


def approve(plan: dict, by: str, at: Optional[str] = None) -> dict:
    analyse(plan)
    blockers = approval_blockers(plan)
    if blockers:
        raise ValueError("Chưa duyệt được test plan:\n  - " + "\n  - ".join(blockers))
    if not by or not by.strip():
        raise ValueError("Cần tên người duyệt (--by).")
    plan["approval"] = {
        "by": by.strip(),
        "at": at or datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "sha256": content_hash(plan),
    }
    return plan


def approval_state(plan: dict) -> tuple:
    """('approved' | 'not_approved' | 'stale', message)."""
    approval = plan.get("approval")
    if not approval:
        return "not_approved", "Test plan chưa được duyệt."
    if approval.get("sha256") != content_hash(plan):
        return "stale", (f"Test plan đã thay đổi sau khi {approval.get('by')} duyệt lúc {approval.get('at')}: "
                         "cần duyệt lại.")
    return "approved", f"Đã duyệt bởi {approval.get('by')} lúc {approval.get('at')}."


# ========= Files =========

class _Dumper(yaml.SafeDumper):
    pass


def _str_representer(dumper, value):
    style = "|" if "\n" in value else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_Dumper.add_representer(str, _str_representer)


def save_plan(plan: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# web-test-toolkit test plan. Review fields per case: automation (auto | partial | manual | need_info),\n"
        "# review (reason / notes) and execution (how to run it). AI proposals: 'proposals' per case (edits) and\n"
        "# 'proposed_cases' (new cases); their status changes only through 'decide'. 'workbook_automation' is the\n"
        "# workbook's Automation column as imported; 'issues' and 'summary' are recomputed by the tool.\n"
    )
    body = yaml.dump(plan, Dumper=_Dumper, allow_unicode=True, sort_keys=False, width=110)
    path.write_text(header + body, encoding="utf-8")
    return path


def load_plan(path: Path) -> dict:
    with Path(path).open(encoding="utf-8") as file:
        plan = yaml.safe_load(file)
    if not isinstance(plan, dict) or plan.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"{path}: not a web-test-toolkit test plan (schema_version {SCHEMA_VERSION}).")
    return plan
