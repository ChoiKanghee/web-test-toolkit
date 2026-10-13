#!/usr/bin/env python3
"""Import test cases from the team workbook into a web-test-toolkit test plan, and gate it.

Commands:
  import   <workbook.xlsx> [--sheet NAME ...] [--out artifacts]
           -> artifacts/<Function>/test-plan.yaml + import-review.md (+ functions.yaml snippet)
  check    <test-plan.yaml>      recompute issues and summary after edits, rewrite the review page
  report   <test-plan.yaml>      print a JSON summary (issues, automation counts, approval state)
  approve  <test-plan.yaml> --by NAME     gate: record approval with a content hash
  verify   <test-plan.yaml>      exit 0 if approved and unchanged since, 3 otherwise

Exit codes: 0 ok, 1 error, 2 bad usage, 3 gate not passed.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wtt import plan as plan_module  # noqa: E402
from wtt.review import functions_yaml_snippet, render_review  # noqa: E402
from wtt.workbook import read_workbook  # noqa: E402


def _write_outputs(plan: dict, plan_path: Path) -> None:
    plan_module.save_plan(plan, plan_path)
    (plan_path.parent / "import-review.md").write_text(render_review(plan), encoding="utf-8")
    (plan_path.parent / "functions.yaml.snippet").write_text(functions_yaml_snippet(plan), encoding="utf-8")


def _summary_json(plan: dict, plan_path: Path) -> dict:
    state, message = plan_module.approval_state(plan)
    return {
        "plan": str(plan_path),
        "function": plan["function"]["name"],
        "sheet": plan["source"]["sheet"],
        "summary": plan["summary"],
        "approval": {"state": state, "message": message},
        "blockers": len(plan_module.approval_blockers(plan)),
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
        if old_plan and old_plan.get("approval"):
            # Keep the approval record: approval_state() reports it as stale if the content changed.
            new_plan["approval"] = old_plan["approval"]
        plan_module.analyse(new_plan)
        if changed:
            for case in new_plan["test_cases"]:
                if case["id"] in changed:
                    case["issues"].append(plan_module._issue(
                        plan_module.WARNING, "changed_since_review",
                        "Nội dung case đã đổi so với lần import trước: cần review lại."))
        _write_outputs(new_plan, plan_path)
        result = _summary_json(new_plan, plan_path)
        result["changed_since_last_import"] = changed
        results.append(result)

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if results else 1


def _load(path_text: str):
    path = Path(path_text)
    if not path.is_file():
        raise FileNotFoundError(f"Không tìm thấy test plan: {path}")
    return path, plan_module.load_plan(path)


def cmd_check(args) -> int:
    path, plan = _load(args.plan)
    plan_module.analyse(plan)
    _write_outputs(plan, path)
    print(json.dumps(_summary_json(plan, path), ensure_ascii=False, indent=2))
    return 0


def cmd_report(args) -> int:
    path, plan = _load(args.plan)
    plan_module.analyse(plan)
    print(json.dumps(_summary_json(plan, path), ensure_ascii=False, indent=2))
    return 0


def cmd_approve(args) -> int:
    path, plan = _load(args.plan)
    try:
        plan_module.approve(plan, args.by)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 3
    _write_outputs(plan, path)
    print(json.dumps(_summary_json(plan, path), ensure_ascii=False, indent=2))
    return 0


def cmd_verify(args) -> int:
    path, plan = _load(args.plan)
    state, message = plan_module.approval_state(plan)
    print(json.dumps({"plan": str(path), "state": state, "message": message}, ensure_ascii=False))
    return 0 if state == "approved" else 3


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
