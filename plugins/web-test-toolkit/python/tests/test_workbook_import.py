import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from conftest import CASES, build_workbook
from wtt import plan as P
from wtt.review import functions_yaml_snippet, render_review
from wtt.workbook import english_label, read_workbook

CLI = Path(__file__).resolve().parents[1] / "wtt_import.py"


def issues_of(case, code=None):
    return [issue for issue in case["issues"] if code is None or issue["code"] == code]


@pytest.fixture()
def plan(workbook_path):
    raw = read_workbook(workbook_path)
    return P.build_plan(raw, raw.case_sheets[0], imported_at="2026-10-11T10:00:00+07:00")


def cases_by_id(plan):
    return {case["id"]: case for case in plan["test_cases"]}


def test_english_label():
    assert english_label("テストケース番号 *\n(TC ID)") == "tc id"
    assert english_label("テスト結果 (Test Result) – Chrome") == "test result"
    assert english_label("plain") is None


def test_reader_finds_only_the_case_sheet(workbook_path):
    raw = read_workbook(workbook_path)
    assert [sheet.name for sheet in raw.case_sheets] == ["001-SHP_Shop"]
    sheet = raw.case_sheets[0]
    assert sheet.meta == {"function_name": "Shop 画面 (Shop)", "module": "Shop", "environment": "Staging / Chrome"}
    assert [case.row for case in sheet.cases] == [9, 10, 11, 12]
    assert sheet.cases[1].runs == ["Failed", "Passed", None]
    assert [item.values["id"] for item in raw.test_data] == ["Q1", "FILE-NG-01"]


def test_reader_rejects_unknown_sheet(workbook_path):
    with pytest.raises(ValueError, match="Sheet not found"):
        read_workbook(workbook_path, ["nope"])


def test_split_numbered():
    assert P.split_numbered("1. a\n2. b\n   more") == ["a", "b\nmore"]
    assert P.split_numbered("no numbers") == ["no numbers"]
    assert P.split_numbered(None) == []


def test_plan_content(plan):
    cases = cases_by_id(plan)
    assert plan["function"] == {"name": "Shop", "display_name": "Shop 画面 (Shop)", "module": "Shop",
                                "environment": "Staging / Chrome", "categories": ["1. 一覧", "2. 詳細"]}
    first = cases["Shop_TC001"]
    assert first["priority"] == "high"
    assert first["expected"] == ["10 products are shown.", "Sorted by name."]
    assert first["source"] == {"sheet": "001-SHP_Shop", "row": 9}
    assert first["automation"] is None and first["review"] is None

    second = cases["Shop_TC002"]
    assert second["test_data"]["refs"] == ["FILE-NG-01"]
    assert second["history"]["runs"] == ["Failed", "Passed", None]
    assert second["history"]["latest"] == "Passed"
    assert second["history"]["bug_ids"] == ["BUG-12"]
    assert plan["test_data"]["FILE-NG-01"]["ready"] is False
    assert plan["test_data"]["Q1"]["ready"] is True
    assert cases["Shop_TC004"]["depends_on"] == ["Shop_TC001"]


def test_issues(plan):
    cases = cases_by_id(plan)
    assert issues_of(cases["Shop_TC001"]) == []
    assert issues_of(cases["Shop_TC002"], "data_not_ready")
    assert issues_of(cases["Shop_TC002"], "known_bug")[0]["severity"] == "info"
    assert issues_of(cases["Shop_TC004"], "vague_expected")
    assert issues_of(cases["Shop_TC004"], "data_example")
    assert issues_of(cases["Shop_TC004"], "failed_without_bug")
    fifth = cases["Shop_TC005"]
    assert {issue["code"] for issue in issues_of(fifth) if issue["severity"] == "error"} == {"missing_steps", "priority"}
    assert issues_of(fifth, "data_unknown_ref")[0]["message"].startswith("Test data nhắc tới 'Q9'")
    assert plan["summary"]["id_gaps"] == ["Shop_TC003"]
    assert plan["summary"]["data_not_ready"] == ["FILE-NG-01"]
    assert plan["summary"]["by_priority"] == {"high": 1, "medium": 1, "low": 1, "urgent": 1}


def test_id_rules(tmp_path):
    cases = [CASES[0], ("Shop_TC001",) + CASES[1][1:], ("Cart_TC003",) + CASES[1][1:], ("SHOP-3",) + CASES[1][1:]]
    raw = read_workbook(build_workbook(tmp_path / "ids.xlsx", cases))
    plan = P.build_plan(raw, raw.case_sheets[0])
    codes = [{issue["code"] for issue in case["issues"]} for case in plan["test_cases"]]
    assert "id_duplicate" in codes[0] and "id_duplicate" in codes[1]
    assert "id_function" in codes[2]
    assert "id_format" in codes[3]


def decide(plan, **decisions):
    for case in plan["test_cases"]:
        automation, review = decisions.get(case["id"], ("auto", None))
        case["automation"], case["review"] = automation, review


def test_approval_blockers(plan):
    blockers = P.approval_blockers(plan)
    assert len(blockers) == 4 and all("chưa có quyết định automation" in item for item in blockers)

    decide(plan, Shop_TC004=("partial", None), Shop_TC005=("auto", None))
    P.analyse(plan)
    blockers = P.approval_blockers(plan)
    assert any(item.startswith("Shop_TC004 (partial): cần ghi lý do") for item in blockers)
    assert any(item.startswith("Shop_TC005 (auto) còn lỗi") for item in blockers)

    decide(plan, Shop_TC004=("partial", "header checked by screenshot"), Shop_TC005=("need_info", "no steps"))
    P.analyse(plan)
    assert P.approval_blockers(plan) == []


def test_approve_and_detect_changes(plan):
    decide(plan, Shop_TC004=("partial", "screenshot"), Shop_TC005=("manual", "no steps"))
    with pytest.raises(ValueError, match="người duyệt"):
        P.approve(plan, " ")
    P.approve(plan, "NCM", at="2026-10-11T10:00:00+07:00")
    assert P.approval_state(plan)[0] == "approved"

    plan["test_cases"][0]["expected"].append("New expectation")
    state, message = P.approval_state(plan)
    assert state == "stale" and "cần duyệt lại" in message


def test_approve_refuses_with_blockers(plan):
    with pytest.raises(ValueError, match="Chưa duyệt được"):
        P.approve(plan, "NCM")
    assert plan["approval"] is None


def test_issues_and_summary_do_not_affect_hash(plan):
    before = P.content_hash(plan)
    plan["test_cases"][0]["issues"].append({"severity": "info", "code": "x", "message": "y"})
    plan["summary"]["total"] = 999
    assert P.content_hash(plan) == before


def test_merge_review(plan, workbook_path, tmp_path):
    decide(plan, Shop_TC004=("partial", "screenshot"), Shop_TC005=("manual", "no steps"))
    edited = list(CASES)
    edited[0] = edited[0][:6] + ("1. 12 products are shown.",) + edited[0][7:]
    raw = read_workbook(build_workbook(tmp_path / "edited.xlsx", edited))
    new_plan = P.build_plan(raw, raw.case_sheets[0])

    changed = P.merge_review(new_plan, plan)

    cases = cases_by_id(new_plan)
    assert changed == ["Shop_TC001"]
    assert cases["Shop_TC001"]["automation"] is None
    assert (cases["Shop_TC004"]["automation"], cases["Shop_TC004"]["review"]) == ("partial", "screenshot")


def test_save_and_load_roundtrip(plan, tmp_path):
    path = P.save_plan(plan, tmp_path / "plan" / "test-plan.yaml")
    assert path.read_text(encoding="utf-8").startswith("# web-test-toolkit test plan")
    loaded = P.load_plan(path)
    assert loaded["test_cases"][1]["expected"] == plan["test_cases"][1]["expected"]
    assert P.content_hash(loaded) == P.content_hash(plan)


def test_load_rejects_other_yaml(tmp_path):
    path = tmp_path / "x.yaml"
    path.write_text("a: 1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not a web-test-toolkit test plan"):
        P.load_plan(path)


def test_review_page_and_snippet(plan):
    page = render_review(plan)
    assert page.startswith("# Review import test case — Shop 画面 (Shop)")
    assert "| Shop_TC005 | 2. 詳細 | ❌ Lỗi | Thiếu Steps" in page
    assert "Shop_TC004 cần trạng thái của Shop_TC001" in page
    assert "Còn 4 điểm chặn duyệt" in page
    assert functions_yaml_snippet(plan) == (
        "  Shop:\n    name: Shop 画面 (Shop)\n    sheet: 001-SHP_Shop\n    categories:\n"
        "      - 1. 一覧\n      - 2. 詳細\n")


def run_cli(*args, cwd):
    return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, capture_output=True, text=True, timeout=60)


def test_cli_end_to_end(workbook_path, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    completed = run_cli("import", str(workbook_path), cwd=work)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)[0]
    assert result["plan"] == "artifacts/Shop/test-plan.yaml"
    plan_path = work / result["plan"]
    for name in ("test-plan.yaml", "import-review.md", "functions.yaml.snippet"):
        assert (plan_path.parent / name).is_file()

    assert run_cli("verify", str(plan_path), cwd=work).returncode == 3
    refused = run_cli("approve", str(plan_path), "--by", "NCM", cwd=work)
    assert refused.returncode == 3 and "Chưa duyệt được" in refused.stderr

    data = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    for case in data["test_cases"]:
        case["automation"] = "manual" if case["id"] == "Shop_TC005" else "auto"
        case["review"] = "no steps" if case["id"] == "Shop_TC005" else None
    plan_path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")

    assert run_cli("check", str(plan_path), cwd=work).returncode == 0
    approved = run_cli("approve", str(plan_path), "--by", "NCM", cwd=work)
    assert approved.returncode == 0, approved.stderr
    assert run_cli("verify", str(plan_path), cwd=work).returncode == 0
    assert "✅ Đã duyệt bởi NCM" in (plan_path.parent / "import-review.md").read_text(encoding="utf-8")

    reimport = run_cli("import", str(workbook_path), cwd=work)
    result = json.loads(reimport.stdout)[0]
    assert result["changed_since_last_import"] == []
    assert result["approval"]["state"] == "approved", "an unchanged re-import keeps the approval"
    kept = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    assert {case["automation"] for case in kept["test_cases"]} == {"auto", "manual"}

    edited = list(CASES)
    edited[0] = edited[0][:2] + ("List shows all products",) + edited[0][3:]
    build_workbook(workbook_path, edited)
    changed = json.loads(run_cli("import", str(workbook_path), cwd=work).stdout)[0]
    assert changed["changed_since_last_import"] == ["Shop_TC001"]
    assert changed["approval"]["state"] == "stale"
    assert run_cli("verify", str(plan_path), cwd=work).returncode == 3


def test_cli_errors(tmp_path):
    assert run_cli("import", str(tmp_path / "missing.xlsx"), cwd=tmp_path).returncode == 1
    assert run_cli("verify", str(tmp_path / "missing.yaml"), cwd=tmp_path).returncode == 1


@pytest.mark.parametrize("runs, expected", [
    ([None, None, None], ("not_run", 1)),
    (["Todo", None, None], ("not_run", 1)),
    (["In progress", None, None], ("in_progress", 1)),
    (["Passed", None, None], ("passed", None)),
    (["N/A", None, None], ("not_applicable", None)),
    (["Failed", None, None], ("retest", 2)),
    (["Blocked", "Failed", None], ("retest", 3)),
    (["Failed", "Passed", None], ("passed", None)),
    (["Failed", "Failed", "Failed"], ("no_round_left", None)),
])
def test_execution_state_follows_retest_rounds(runs, expected):
    assert P.execution_state(runs) == expected


def set_runs(plan, case_id, runs):
    case = cases_by_id(plan)[case_id]
    case["history"]["runs"] = runs
    case["history"]["latest"] = [run for run in runs if run][-1] if any(runs) else "Todo"
    case["history"]["state"], case["history"]["next_round"] = P.execution_state(runs)
    return case


def test_round_issues(plan):
    gap = set_runs(plan, "Shop_TC001", [None, "Failed", None])
    after_done = set_runs(plan, "Shop_TC002", ["Passed", "Failed", None])
    exhausted = set_runs(plan, "Shop_TC004", ["Failed", "Failed", "Failed"])
    P.analyse(plan)
    assert issues_of(gap, "round_gap")
    assert issues_of(after_done, "round_after_done")
    assert issues_of(exhausted, "no_round_left")
    assert plan["summary"]["by_execution_state"]["no_round_left"] == 1


def test_summary_counts_execution_states(plan):
    states = plan["summary"]["by_execution_state"]
    # TC001 Passed, TC002 Failed→Passed, TC004 Failed (retest in 2回目), TC005 not run
    assert states == {"not_run": 1, "passed": 2, "retest": 1}
    assert cases_by_id(plan)["Shop_TC004"]["history"]["next_round"] == 2
    assert "Cần retest (Failed/Blocked, ghi vào lần tiếp theo) | 1" in render_review(plan)


@pytest.mark.parametrize("expected", [
    "Header is displayed as designed.", "ヘッダーがデザイン通りに表示される。", "メッセージが適切に表示される。",
    "仕様通りに動作する。", "The layout matches the design.", "Error message is appropriate.",
])
def test_vague_expected_in_three_languages(plan, expected):
    case = cases_by_id(plan)["Shop_TC001"]
    case["expected"] = [expected]
    P.analyse(plan)
    assert issues_of(case, "vague_expected"), expected


@pytest.mark.parametrize("text", ["例えば「テスト」", "例：山田太郎", "(例) abc", "e.g. 'abc'", "for example: abc", "vd 'abc'"])
def test_example_values_in_three_languages(plan, text):
    case = cases_by_id(plan)["Shop_TC001"]
    case["test_data"] = {"text": text, "refs": []}
    P.analyse(plan)
    assert issues_of(case, "data_example"), text


@pytest.mark.parametrize("expected", ["10 products are shown.", "トーストが表示される。", "Hiển thị toast 'Đã lưu'."])
def test_concrete_expected_is_not_flagged(plan, expected):
    case = cases_by_id(plan)["Shop_TC001"]
    case["expected"] = [expected]
    P.analyse(plan)
    assert not issues_of(case, "vague_expected"), expected
