"""The tester's own confirmation at the import gates: plan approval and decisions on AI proposals.

An approval or a decision is a person's act, so the commands that record one (`approve`, `decide`) run only
in an interactive terminal and ask the tester to type a confirmation. Each writes a record under
artifacts/<Function>/.approvals/ next to the plan:

  plan.json        {by, at, sha256}           the plan approval
  decisions.json   {fingerprint: {...}}      one entry per decided proposal, keyed by its content

The plan file also shows approvals and decisions, but the tool only counts what the records back: a plan
approval in test-plan.yaml without a matching plan.json is "unverified", and a proposal whose content has no
decision record is still undecided, whatever its 'status' says. A proposal edited after the decision no
longer matches its record, so it needs a new decision.

This keeps an agent from approving for the tester by habit or by mistake: it has no terminal, and the setup
skill denies it edits under .approvals/. It is not a defence against someone deliberately forging the files.
"""

import hashlib
import json
import sys
from pathlib import Path
from typing import Optional

from wtt import plan as P
from wtt import proposals as R

RECORD_DIR = ".approvals"
PLAN_RECORD = "plan.json"
DECISIONS = "decisions.json"
FINGERPRINT_FIELDS = {
    "edit": ("field", "value"),
    "new_case": ("id", "category", "title", "preconditions", "steps", "test_data", "expected", "priority",
                 "automation"),
}


class NotATerminal(Exception):
    pass


def require_terminal(action: str, streams=None) -> None:
    stdin, stdout = streams or (sys.stdin, sys.stdout)
    if not (stdin.isatty() and stdout.isatty()):
        raise NotATerminal(
            f"Lệnh {action} phải do tester tự chạy trong terminal (cần nhập xác nhận). Agent không {action} thay "
            "tester. Trên Windows dùng PowerShell / Windows Terminal, không dùng Git Bash.")


def confirm(prompt: str, expected: str, read=input) -> bool:
    try:
        answer = read(prompt)
    except EOFError:
        return False
    return answer.strip().lower() == expected.strip().lower()


def records_dir(plan_path: Path) -> Path:
    return Path(plan_path).parent / RECORD_DIR


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ========= Plan approval =========

def write_plan_record(plan_path: Path, plan: dict) -> None:
    approval = plan["approval"]
    _write_json(records_dir(plan_path) / PLAN_RECORD,
                {"by": approval["by"], "at": approval["at"], "sha256": approval["sha256"]})


def plan_state(plan_path: Path, plan: dict) -> tuple:
    """approval_state() of the plan, downgraded to 'unverified' unless the tester's record backs it."""
    state, message = P.approval_state(plan)
    if state != "approved":
        return state, message
    record = _read_json(records_dir(plan_path) / PLAN_RECORD)
    approval = plan.get("approval") or {}
    if not record or any(record.get(key) != approval.get(key) for key in ("by", "at", "sha256")):
        return "unverified", ("Bản duyệt trong test-plan.yaml không có bản ghi xác nhận của tester "
                              "(.approvals/plan.json): tester tự chạy approve trong terminal.")
    return state, message


# ========= Decisions on proposals =========

def fingerprint(kind: str, proposal: dict) -> str:
    content = {name: proposal.get(name) for name in FINGERPRINT_FIELDS[kind]}
    if kind == "edit":
        content["value"] = R.normalized(proposal.get("field"), proposal.get("value"))
    encoded = json.dumps({"kind": kind, **content}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def load_decisions(plan_path: Path) -> dict:
    return _read_json(records_dir(plan_path) / DECISIONS) or {}


def record_decisions(plan_path: Path, plan: dict, handles: list) -> None:
    """Add the decisions just made on these handles to decisions.json."""
    decisions = load_decisions(plan_path)
    for handle, kind, case, proposal in R.iter_proposals(plan):
        if handle not in handles:
            continue
        decisions[fingerprint(kind, proposal)] = {
            "handle": handle, "case": case["id"] if case else proposal.get("id"),
            "status": proposal["status"], **(proposal.get("decided") or {}),
        }
    _write_json(records_dir(plan_path) / DECISIONS, decisions)


def apply_decisions(plan: dict, decisions: dict) -> list:
    """Make every proposal's status what the records say: undecided ('proposed') when no record backs it.

    Run before anything reads a status, so a status typed into the YAML has no effect.
    Returns the handles whose status was reset.
    """
    reset = []
    for handle, kind, _, proposal in R.iter_proposals(plan):
        if proposal.get("written"):
            continue
        record = decisions.get(fingerprint(kind, proposal))
        status = record.get("status") if record else "proposed"
        if (proposal.get("status") or "proposed") != status:
            reset.append(handle)
        proposal["status"] = status
        if record:
            proposal["decided"] = {key: record[key] for key in ("by", "at", "note") if key in record}
        else:
            proposal.pop("decided", None)
    return reset


def describe(kind: str, case: Optional[dict], proposal: dict) -> str:
    if kind == "edit":
        value = proposal.get("value")
        text = " / ".join(R.as_list(value)) if proposal.get("field") in R.LIST_FIELDS else str(value)
        return f"sửa {R.FIELD_LABELS.get(proposal.get('field'), proposal.get('field'))} của {case['id']}: {text}"
    return f"case mới {proposal.get('id')}: {proposal.get('title')}"
