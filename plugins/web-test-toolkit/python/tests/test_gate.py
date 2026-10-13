"""The tester is the last check at every gate: approvals and decisions count only when the tester confirmed
them in a terminal, which leaves a record under .approvals/."""

import io
import json
import subprocess
import sys

import pytest
import yaml

from conftest import CLI, build_workbook, needs_pty, run_cli_tty
from wtt import gate as G
from wtt import plan as P


def run_cli(*args, cwd):
    return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, capture_output=True, text=True, timeout=60,
                          stdin=subprocess.DEVNULL)


def imported(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    workbook = build_workbook(work / "cases.xlsx")
    plan_path = work / json.loads(run_cli("import", str(workbook), cwd=work).stdout)[0]["plan"]
    return work, workbook, plan_path


def edit_yaml(plan_path, mutate):
    data = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    mutate(data)
    plan_path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def decide_everything(data):
    for case in data["test_cases"]:
        case["automation"], case["review"] = ("need_info", "No steps.") if case["id"] == "Shop_TC005" else ("auto", None)


NEW_CASE = {"id": "Shop_TC006", "category": "2. 詳細", "title": "Back", "steps": ["Click Back."],
            "expected": ["The list is shown."], "priority": "Medium", "automation": "auto", "reason": "No case for Back.",
            "source": "inference", "status": "proposed"}


class FakeStream(io.StringIO):
    def __init__(self, tty):
        super().__init__()
        self._tty = tty

    def isatty(self):
        return self._tty


# ---------- terminal and confirmation ----------

@pytest.mark.parametrize("stdin_tty, stdout_tty", [(False, True), (True, False), (False, False)])
def test_require_terminal_refuses_without_one(stdin_tty, stdout_tty):
    with pytest.raises(G.NotATerminal, match="phải do tester tự chạy trong terminal"):
        G.require_terminal("duyệt", (FakeStream(stdin_tty), FakeStream(stdout_tty)))


def test_require_terminal_accepts_one():
    G.require_terminal("duyệt", (FakeStream(True), FakeStream(True)))


def test_confirm():
    assert G.confirm("? ", "Shop", read=lambda prompt: " shop ")
    assert not G.confirm("? ", "Shop", read=lambda prompt: "")
    assert not G.confirm("? ", "Shop", read=lambda prompt: "y")

    def eof(prompt):
        raise EOFError
    assert not G.confirm("? ", "Shop", read=eof)


def test_approve_and_decide_refuse_without_a_terminal(tmp_path):
    work, _, plan_path = imported(tmp_path)
    edit_yaml(plan_path, decide_everything)
    edit_yaml(plan_path, lambda data: data.__setitem__("proposed_cases", [dict(NEW_CASE)]))
    before = plan_path.read_text(encoding="utf-8")
    for args in (("approve", str(plan_path), "--by", "NCM"), ("decide", str(plan_path), "all", "--accept", "--by", "NCM")):
        refused = run_cli(*args, cwd=work)
        assert refused.returncode == 3 and "phải do tester tự chạy trong terminal" in refused.stderr
    assert plan_path.read_text(encoding="utf-8") == before
    assert not (plan_path.parent / ".approvals").exists()


@needs_pty
def test_wrong_confirmation_writes_nothing(tmp_path):
    work, _, plan_path = imported(tmp_path)
    edit_yaml(plan_path, decide_everything)
    cancelled = run_cli_tty("approve", str(plan_path), "--by", "NCM", cwd=work, answer="yes")
    assert cancelled.returncode == 3 and "Đã huỷ" in cancelled.output
    assert "Gõ tên chức năng (Shop)" in cancelled.output
    assert run_cli("verify", str(plan_path), cwd=work).returncode == 3
    assert not (plan_path.parent / ".approvals").exists()


# ---------- approvals typed into the plan do not count ----------

@needs_pty
def test_approval_written_into_the_yaml_is_unverified(tmp_path):
    work, workbook, plan_path = imported(tmp_path)

    def approve_without_the_tester(data):
        decide_everything(data)
        plan = P.load_plan(plan_path)
        decide_everything(plan)
        P.approve(plan, "NCM")
        data["approval"] = plan["approval"]
    edit_yaml(plan_path, approve_without_the_tester)

    verified = run_cli("verify", str(plan_path), cwd=work)
    assert verified.returncode == 3 and json.loads(verified.stdout)["state"] == "unverified"
    for args in (("select", str(plan_path)), ("write-automation", str(plan_path), str(workbook))):
        refused = run_cli(*args, cwd=work)
        assert refused.returncode == 3 and "không có bản ghi xác nhận của tester" in refused.stderr
    assert run_cli("check", str(plan_path), cwd=work).returncode == 0
    assert "không có bản ghi xác nhận của tester" in (plan_path.parent / "import-review.md").read_text(encoding="utf-8")

    approved = run_cli_tty("approve", str(plan_path), "--by", "NCM", cwd=work, answer="Shop")
    assert approved.returncode == 0, approved.output
    assert run_cli("verify", str(plan_path), cwd=work).returncode == 0
    record = json.loads((plan_path.parent / ".approvals" / "plan.json").read_text(encoding="utf-8"))
    assert record["by"] == "NCM" and len(record["sha256"]) == 64


def test_plan_state_needs_a_matching_record(tmp_path):
    plan_path = tmp_path / "Shop" / "test-plan.yaml"
    raw_plan = _approved_plan(tmp_path)
    assert G.plan_state(plan_path, raw_plan)[0] == "unverified"
    G.write_plan_record(plan_path, raw_plan)
    assert G.plan_state(plan_path, raw_plan)[0] == "approved"
    raw_plan["approval"]["by"] = "Someone else"
    assert G.plan_state(plan_path, raw_plan)[0] == "unverified"


def _approved_plan(tmp_path):
    from wtt.workbook import read_workbook
    raw = read_workbook(build_workbook(tmp_path / "w.xlsx"))
    plan = P.build_plan(raw, raw.case_sheets[0])
    decide_everything(plan)
    P.approve(plan, "NCM", at="2026-10-13T10:00:00+07:00")
    return plan


# ---------- decisions typed into the plan do not count ----------

@needs_pty
def test_status_typed_into_the_yaml_is_reset(tmp_path):
    work, workbook, plan_path = imported(tmp_path)
    edit_yaml(plan_path, lambda data: data.__setitem__("proposed_cases", [dict(NEW_CASE, status="accepted",
                                                                              decided={"by": "NCM", "at": "t"})]))
    nothing = run_cli("write-changes", str(plan_path), str(workbook), cwd=work)
    assert nothing.returncode == 0 and "Không có đề xuất" in nothing.stdout
    assert run_cli("check", str(plan_path), cwd=work).returncode == 0
    data = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    assert data["proposed_cases"][0]["status"] == "proposed" and "decided" not in data["proposed_cases"][0]

    decided = run_cli_tty("decide", str(plan_path), "Shop_TC006", "--accept", "--by", "NCM", cwd=work, answer="1")
    assert decided.returncode == 0, decided.output
    assert "sắp CHẤP NHẬN 1 đề xuất" in decided.output and "case mới Shop_TC006: Back" in decided.output
    decisions = json.loads((plan_path.parent / ".approvals" / "decisions.json").read_text(encoding="utf-8"))
    assert [(entry["handle"], entry["status"], entry["by"]) for entry in decisions.values()] == [("Shop_TC006", "accepted", "NCM")]


@needs_pty
def test_a_proposal_changed_after_the_decision_needs_a_new_one(tmp_path):
    work, workbook, plan_path = imported(tmp_path)
    edit_yaml(plan_path, lambda data: data.__setitem__("proposed_cases", [dict(NEW_CASE)]))
    assert run_cli_tty("decide", str(plan_path), "Shop_TC006", "--accept", "--by", "NCM", cwd=work, answer="1").returncode == 0

    edit_yaml(plan_path, lambda data: data["proposed_cases"][0].__setitem__("expected", ["Something else."]))
    assert run_cli("check", str(plan_path), cwd=work).returncode == 0
    data = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    assert data["proposed_cases"][0]["status"] == "proposed"
    nothing = run_cli("write-changes", str(plan_path), str(workbook), cwd=work)
    assert "Không có đề xuất" in nothing.stdout


def test_fingerprint_ignores_status_and_review_but_not_content():
    base = dict(NEW_CASE)
    assert G.fingerprint("new_case", base) == G.fingerprint("new_case", dict(base, status="accepted", review="x"))
    assert G.fingerprint("new_case", base) != G.fingerprint("new_case", dict(base, priority="High"))
    edit = {"field": "expected", "value": "1. a\n2. b"}
    assert G.fingerprint("edit", edit) == G.fingerprint("edit", {"field": "expected", "value": ["a", "b"]})
