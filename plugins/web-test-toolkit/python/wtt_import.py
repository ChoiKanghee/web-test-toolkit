#!/usr/bin/env python3
"""Import test cases from the team workbook into a web-test-toolkit test plan, and gate it.

Commands:
  import   <workbook.xlsx> [--sheet NAME ...] [--out artifacts]
           -> artifacts/<Function>/test-plan.yaml + import-review.md (+ functions.yaml snippet)
  check    <test-plan.yaml>      recompute issues and summary after edits, rewrite the review page
  report   <test-plan.yaml>      print a JSON summary (issues, automation counts, approval state)
  approve  <test-plan.yaml> --by NAME     gate, tester only (terminal + typed confirmation): approve the plan
  verify   <test-plan.yaml>      exit 0 if approved and unchanged since, 3 otherwise
  decide   <test-plan.yaml> HANDLE... --accept|--reject --by NAME [--note TEXT]
           gate, tester only (terminal + typed confirmation): decide on AI proposals
           (HANDLE: <TC ID>#<n> for an edit, <TC ID> for a new case, or 'all')
  write-changes <test-plan.yaml> <workbook.xlsx> [--out PATH | --in-place]
           write accepted proposals into the workbook (then import the written file again)
  write-automation <test-plan.yaml> <workbook.xlsx> [--out PATH | --in-place]
           after approval: write Automated / Not Automated into the workbook's Automation column
  select   <test-plan.yaml> [--scope all|pending|retest] [--format lines|json|pytest-k]
           after approval: the cases the executor runs (Automated only)

approve and decide record the tester's confirmation in artifacts/<Function>/.approvals/; an approval or a
decision typed into test-plan.yaml without that record does not count.

Exit codes: 0 ok, 1 error, 2 bad usage, 3 gate not passed (or no terminal / not confirmed).
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import copy  # noqa: E402

from wtt import gate as gate_module  # noqa: E402
from wtt import plan as plan_module  # noqa: E402
from wtt import proposals as proposals_module  # noqa: E402
from wtt.review import functions_yaml_snippet, render_review  # noqa: E402
from wtt.workbook import read_workbook, write_automation_marks, write_case_changes  # noqa: E402


def _prepare(plan: dict, plan_path: Path) -> dict:
    """Statuses of proposals from the tester's decision records, then the checks."""
    gate_module.apply_decisions(plan, gate_module.load_decisions(plan_path))
    plan_module.analyse(plan)
    return plan


def _write_outputs(plan: dict, plan_path: Path) -> None:
    plan_module.save_plan(plan, plan_path)
    review = render_review(plan, gate_module.plan_state(plan_path, plan))
    (plan_path.parent / "import-review.md").write_text(review, encoding="utf-8")
    (plan_path.parent / "functions.yaml.snippet").write_text(functions_yaml_snippet(plan), encoding="utf-8")


def _summary_json(plan: dict, plan_path: Path) -> dict:
    state, message = gate_module.plan_state(plan_path, plan)
    return {
        "plan": str(plan_path),
        "function": plan["function"]["name"],
        "sheet": plan["source"]["sheet"],
        "summary": plan["summary"],
        "approval": {"state": state, "message": message},
        "blockers": len(plan_module.approval_blockers(plan)),
        "next_free_id": proposals_module.next_free_id(plan),
    }


def cmd_import(args) -> int:
    workbook_path = Path(args.workbook)
    if not workbook_path.is_file():
        print(f"Không tìm thấy file: {workbook_path}", file=sys.stderr)
        return 1
    try:
        raw = read_workbook(workbook_path, args.sheet)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1

    results = []
    for sheet in raw.case_sheets:
        if not sheet.cases:
            print(f"Bỏ qua sheet '{sheet.name}': không có test case.", file=sys.stderr)
            continue
        new_plan = plan_module.build_plan(raw, sheet)
        name = new_plan["function"]["name"] or sheet.name
        plan_path = Path(args.out) / name / "test-plan.yaml"

        old_plan = None
        if plan_path.is_file():
            try:
                old_plan = plan_module.load_plan(plan_path)
            except ValueError:
                old_plan = None
        changed = plan_module.merge_review(new_plan, old_plan)
        from_proposals = proposals_module.carry_over(new_plan, old_plan)
        from_workbook = plan_module.apply_workbook_marks(new_plan, old_plan)
        if old_plan and old_plan.get("approval"):
            # Keep the approval record: approval_state() reports it as stale if the content changed.
            new_plan["approval"] = old_plan["approval"]
        _prepare(new_plan, plan_path)
        if changed:
            for case in new_plan["test_cases"]:
                if case["id"] in changed:
                    case["issues"].append(plan_module._issue(
                        plan_module.WARNING, "changed_since_review",
                        "Nội dung case đã đổi so với lần import trước: cần review lại."))
        _write_outputs(new_plan, plan_path)
        result = _summary_json(new_plan, plan_path)
        result["changed_since_last_import"] = changed
        result["automation_from_workbook"] = from_workbook
        result["added_from_proposals"] = from_proposals
        results.append(result)

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if results else 1


def _load(path_text: str):
    path = Path(path_text)
    if not path.is_file():
        raise FileNotFoundError(f"Không tìm thấy test plan: {path}")
    return path, _prepare(plan_module.load_plan(path), path)


def cmd_check(args) -> int:
    path, plan = _load(args.plan)
    _write_outputs(plan, path)
    print(json.dumps(_summary_json(plan, path), ensure_ascii=False, indent=2))
    return 0


def cmd_report(args) -> int:
    path, plan = _load(args.plan)
    print(json.dumps(_summary_json(plan, path), ensure_ascii=False, indent=2))
    return 0


def cmd_approve(args) -> int:
    path, plan = _load(args.plan)
    try:
        gate_module.require_terminal("duyệt")
    except gate_module.NotATerminal as error:
        print(str(error), file=sys.stderr)
        return 3
    blockers = plan_module.approval_blockers(plan)
    if blockers:
        print("Chưa duyệt được test plan:\n  - " + "\n  - ".join(blockers), file=sys.stderr)
        return 3
    if not args.by or not args.by.strip():
        print("Cần tên người duyệt (--by).", file=sys.stderr)
        return 3
    function = plan["function"]["name"]
    summary = plan["summary"]
    automation = ", ".join(f"{key}: {value}" for key, value in summary["by_automation"].items())
    print(f"Duyệt test plan {function} ({plan['source']['file']} / {plan['source']['sheet']}), "
          f"người duyệt: {args.by.strip()}")
    print(f"  {summary['total']} case — {automation}; có thông tin chạy: {summary.get('with_execution', 0)}")
    print(f"  Trang review: {path.parent / 'import-review.md'}")
    if not gate_module.confirm(f"Đã review? Gõ tên chức năng ({function}) để duyệt (Enter để huỷ): ", function):
        print("Đã huỷ, không ghi gì.", file=sys.stderr)
        return 3
    plan_module.approve(plan, args.by)
    gate_module.write_plan_record(path, plan)
    _write_outputs(plan, path)
    print(json.dumps(_summary_json(plan, path), ensure_ascii=False, indent=2))
    return 0


def cmd_verify(args) -> int:
    path, plan = _load(args.plan)
    state, message = gate_module.plan_state(path, plan)
    print(json.dumps({"plan": str(path), "state": state, "message": message}, ensure_ascii=False))
    return 0 if state == "approved" else 3


def _require_approved(path: Path, plan: dict) -> bool:
    state, message = gate_module.plan_state(path, plan)
    if state != "approved":
        print(f"{path}: {message} Duyệt test plan trước (approve --by <tên>).", file=sys.stderr)
        return False
    return True


def cmd_write_automation(args) -> int:
    path, plan = _load(args.plan)
    if not _require_approved(path, plan):
        return 3
    workbook_path = Path(args.workbook)
    if not workbook_path.is_file():
        print(f"Không tìm thấy file: {workbook_path}", file=sys.stderr)
        return 1
    if not _same_workbook(plan, workbook_path, "duyệt lại và ghi cột Automation"):
        return 3
    out_path = _target(workbook_path, args, "automation")
    result = write_automation_marks(workbook_path, out_path, plan["source"]["sheet"], plan_module.workbook_marks(plan))
    print(json.dumps({
        "workbook": str(out_path),
        "sheet": plan["source"]["sheet"],
        "written": result["written"],
        "unchanged": len(result["unchanged"]),
        "missing_in_workbook": result["missing"],
        "automated": sum(1 for mark in plan_module.workbook_marks(plan).values() if mark == plan_module.AUTOMATED),
        "not_automated": sum(1 for mark in plan_module.workbook_marks(plan).values() if mark == plan_module.NOT_AUTOMATED),
    }, ensure_ascii=False, indent=2))
    return 0


def _target(workbook_path: Path, args, suffix: str) -> Path:
    if args.in_place:
        return workbook_path
    if args.out:
        return Path(args.out)
    return workbook_path.with_name(f"{workbook_path.stem}_{suffix}{workbook_path.suffix}")


def _same_workbook(plan: dict, workbook_path: Path, action: str) -> bool:
    if hashlib.sha256(workbook_path.read_bytes()).hexdigest() != plan["source"]["sha256"]:
        print(f"{workbook_path.name} đã thay đổi sau lần import của plan này (hoặc không phải file đã import): "
              f"import lại rồi mới {action}.", file=sys.stderr)
        return False
    return True


def cmd_decide(args) -> int:
    path, plan = _load(args.plan)
    try:
        gate_module.require_terminal("quyết định đề xuất")
    except gate_module.NotATerminal as error:
        print(str(error), file=sys.stderr)
        return 3
    trial = copy.deepcopy(plan)
    try:
        handles = proposals_module.decide(trial, args.handles, accept=args.accept, by=args.by, note=args.note)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    verb = "CHẤP NHẬN" if args.accept else "TỪ CHỐI"
    print(f"{args.by.strip()} sắp {verb} {len(handles)} đề xuất:")
    for handle, kind, case, proposal in proposals_module.iter_proposals(plan):
        if handle in handles:
            print(f"  - {handle}: {gate_module.describe(kind, case, proposal)}")
    if not gate_module.confirm(f"Gõ số đề xuất ({len(handles)}) để xác nhận (Enter để huỷ): ", str(len(handles))):
        print("Đã huỷ, không ghi gì.", file=sys.stderr)
        return 3
    proposals_module.decide(plan, handles, accept=args.accept, by=args.by, note=args.note)
    gate_module.record_decisions(path, plan, handles)
    plan_module.analyse(plan)
    _write_outputs(plan, path)
    print(json.dumps({"plan": str(path), "decision": "accepted" if args.accept else "rejected", "proposals": handles,
                      "open": proposals_module.blockers(plan)}, ensure_ascii=False, indent=2))
    return 0


def _source_label(proposals: list) -> str:
    sources = sorted({proposal.get("source") for proposal in proposals if proposal.get("source")})
    deciders = sorted({(proposal.get("decided") or {}).get("by") for proposal in proposals if proposal.get("decided")})
    return f"nguồn: {', '.join(sources)}", ", ".join(deciders)


def cmd_write_changes(args) -> int:
    path, plan = _load(args.plan)
    workbook_path = Path(args.workbook)
    if not workbook_path.is_file():
        print(f"Không tìm thấy file: {workbook_path}", file=sys.stderr)
        return 1
    edits, new_cases = proposals_module.pending_writes(plan)
    if not edits and not new_cases:
        print(json.dumps({"plan": str(path), "written": None,
                          "message": "Không có đề xuất nào đã chấp nhận mà chưa ghi."}, ensure_ascii=False))
        return 0
    if not _same_workbook(plan, workbook_path, "ghi đề xuất"):
        return 3

    today = datetime.now().strftime("%Y-%m-%d")
    notes = {}
    by_case = {}
    for _, case_id, field, _, proposal in edits:
        by_case.setdefault(case_id, []).append((field, proposal))
    for case_id, items in by_case.items():
        fields = ", ".join(dict.fromkeys(proposals_module.FIELD_LABELS[field] for field, _ in items))
        source, deciders = _source_label([proposal for _, proposal in items])
        notes[case_id] = f"[AI {today}] {deciders} duyệt sửa: {fields} ({source})."
    for proposal in new_cases:
        source, deciders = _source_label([proposal])
        notes[proposal["id"]] = f"[AI {today}] Case mới do AI đề xuất ({source}), {deciders} duyệt."

    out_path = _target(workbook_path, args, "updated")
    try:
        result = write_case_changes(
            workbook_path, out_path, plan["source"]["sheet"],
            [(case_id, field, value) for _, case_id, field, value, _ in edits],
            [proposals_module.new_case_values(proposal) for proposal in new_cases],
            notes)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    proposals_module.mark_written([proposal for *_, proposal in edits] + new_cases, out_path.name)
    plan_module.analyse(plan)
    _write_outputs(plan, path)
    print(json.dumps({
        "workbook": str(out_path),
        "sheet": plan["source"]["sheet"],
        "edited": result["edited"],
        "added": result["added"],
        "beyond_template_rows": result["beyond_template_rows"],
        "next": f"import {out_path}",
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_select(args) -> int:
    path, plan = _load(args.plan)
    if not _require_approved(path, plan):
        return 3
    cases = plan_module.execution_cases(plan, args.scope)
    ids = [case["id"] for case in cases]
    if args.format == "json":
        print(json.dumps([{
            "id": case["id"],
            "category": case.get("category"),
            "title": case.get("title"),
            "priority": case.get("priority"),
            "automation": case["automation"],
            "state": (case.get("history") or {}).get("state"),
            "next_round": (case.get("history") or {}).get("next_round"),
        } for case in cases], ensure_ascii=False, indent=2))
    elif args.format == "pytest-k":
        print(" or ".join(ids))
    else:
        print("\n".join(ids))
    if not ids:
        print(f"Không có case Automated nào trong phạm vi '{args.scope}'.", file=sys.stderr)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("import", help="Import a workbook into test plans.")
    p.add_argument("workbook")
    p.add_argument("--sheet", action="append", help="Sheet to import (repeatable). Default: every test case sheet.")
    p.add_argument("--out", default="artifacts", help="Output folder (default: artifacts).")
    p.set_defaults(func=cmd_import)

    for name, func, text in (("check", cmd_check, "Recompute issues after edits."),
                             ("report", cmd_report, "Print a JSON summary."),
                             ("verify", cmd_verify, "Check the approval gate.")):
        p = sub.add_parser(name, help=text)
        p.add_argument("plan")
        p.set_defaults(func=func)

    p = sub.add_parser("approve", help="Approve the plan (gate).")
    p.add_argument("plan")
    p.add_argument("--by", required=True, help="Name of the approving tester.")
    p.set_defaults(func=cmd_approve)

    p = sub.add_parser("decide", help="Accept or reject AI proposals (tester decision).")
    p.add_argument("plan")
    p.add_argument("handles", nargs="+", help="<TC ID>#<n> (edit), <TC ID> (new case), or 'all' for every undecided one.")
    decision = p.add_mutually_exclusive_group(required=True)
    decision.add_argument("--accept", action="store_true")
    decision.add_argument("--reject", action="store_true")
    p.add_argument("--by", required=True, help="Name of the deciding tester.")
    p.add_argument("--note", help="Optional note kept with the decision.")
    p.set_defaults(func=cmd_decide)

    p = sub.add_parser("write-changes", help="Write accepted proposals into the workbook.")
    p.add_argument("plan")
    p.add_argument("workbook", help="The workbook this plan was imported from (unchanged since).")
    target = p.add_mutually_exclusive_group()
    target.add_argument("--out", help="Output workbook (default: <name>_updated.xlsx next to the input).")
    target.add_argument("--in-place", action="store_true", help="Overwrite the input workbook.")
    p.set_defaults(func=cmd_write_changes)

    p = sub.add_parser("write-automation", help="Write the approved decisions into the workbook's Automation column.")
    p.add_argument("plan")
    p.add_argument("workbook", help="The workbook this plan was imported from (unchanged since).")
    target = p.add_mutually_exclusive_group()
    target.add_argument("--out", help="Output workbook (default: <name>_automation.xlsx next to the input).")
    target.add_argument("--in-place", action="store_true", help="Overwrite the input workbook.")
    p.set_defaults(func=cmd_write_automation)

    p = sub.add_parser("select", help="List the cases to execute (Automated only, approved plan).")
    p.add_argument("plan")
    p.add_argument("--scope", choices=plan_module.EXECUTION_SCOPES, default="all",
                   help="all: every Automated case; pending: no final result yet; retest: Failed/Blocked waiting for the next round.")
    p.add_argument("--format", choices=("lines", "json", "pytest-k"), default="lines",
                   help="lines: one TC ID per line; pytest-k: an expression for pytest -k.")
    p.set_defaults(func=cmd_select)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except FileNotFoundError as error:
        print(str(error), file=sys.stderr)
        return 1
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
