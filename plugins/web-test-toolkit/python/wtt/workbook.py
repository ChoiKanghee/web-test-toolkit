"""Read test cases from the team test case workbook (結合テスト仕様書兼結果書 template).

The template is located by its bilingual headers, not by fixed cells: every column
header ends with an English label in parentheses, e.g. "テストケース番号 *\n(TC ID)".
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from openpyxl import load_workbook
from openpyxl.worksheet.worksheet import Worksheet


HEADER_SCAN_ROWS = 20

# English label inside the header parentheses -> field name
CASE_COLUMNS = {
    "tc id": "id",
    "category": "category",
    "title": "title",
    "pre-condition": "precondition",
    "precondition": "precondition",
    "steps": "steps",
    "test data": "test_data",
    "expected result": "expected",
    "priority": "priority",
    "final result": "final_result",
    "tester / pic": "tester",
    "tester": "tester",
    "date": "date",
    "bug id": "bug_id",
    "note": "note",
}
RUN_LABELS = ("1st", "2nd", "3rd", "4th", "5th")

META_LABELS = {
    "screen / function name": "function_name",
    "module": "module",
    "environment": "environment",
}

DATA_COLUMNS = {
    "data id": "id",
    "type": "type",
    "content": "content",
    "language": "language",
    "used in": "used_in",
    "note": "note",
}

_PAREN = re.compile(r"\(([^()]*)\)\s*$")


def english_label(value) -> Optional[str]:
    """'テストケース番号 *\\n(TC ID)' -> 'tc id'; 'テスト結果 (Test Result) – Chrome' -> 'test result'."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    match = _PAREN.search(text)
    if not match:
        match = re.search(r"\(([^()]*)\)", text)
    return match.group(1).strip().lower() if match else None


def clean(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).replace("\r\n", "\n").strip()
    return text or None


@dataclass
class RawCase:
    row: int
    values: dict
    runs: list = field(default_factory=list)


@dataclass
class RawSheet:
    name: str
    meta: dict
    columns: dict
    cases: list


@dataclass
class RawDataItem:
    row: int
    values: dict


def _find_header_row(ws: Worksheet, wanted: str) -> Optional[int]:
    for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, HEADER_SCAN_ROWS)):
        for cell in row:
            if english_label(cell.value) == wanted:
                return cell.row
    return None


def _find_case_header_row(ws: Worksheet) -> Optional[int]:
    """The row holding the TC ID, Steps and Expected Result headers together.

    Other sheets may mention '(TC ID)' (e.g. the Item Description sheet) without being a case sheet.
    """
    for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, HEADER_SCAN_ROWS)):
        labels = {CASE_COLUMNS.get(english_label(cell.value) or "") for cell in row}
        if {"id", "steps", "expected"} <= labels:
            return row[0].row
    return None


def is_case_sheet(ws: Worksheet) -> bool:
    return _find_case_header_row(ws) is not None


def _sheet_meta(ws: Worksheet, header_row: int) -> dict:
    meta = {}
    for row in ws.iter_rows(min_row=1, max_row=header_row - 1):
        cells = [cell for cell in row if cell.value not in (None, "")]
        for index, cell in enumerate(cells):
            name = META_LABELS.get(english_label(cell.value) or "")
            if name and index + 1 < len(cells):
                value = clean(cells[index + 1].value)
                if value and META_LABELS.get(english_label(value) or "") is None:
                    meta[name] = value
    return meta


def read_case_sheet(ws: Worksheet) -> RawSheet:
    header_row = _find_case_header_row(ws)
    if header_row is None:
        raise ValueError(f"Sheet '{ws.title}' is not a test case sheet (no row with TC ID, Steps and Expected Result headers).")

    columns = {}
    for cell in ws[header_row]:
        name = CASE_COLUMNS.get(english_label(cell.value) or "")
        if name and name not in columns:
            columns[name] = cell.column

    run_columns = []
    sub_row = header_row + 1
    for cell in ws[sub_row]:
        label = english_label(cell.value)
        if label in RUN_LABELS:
            run_columns.append((RUN_LABELS.index(label), cell.column))
    run_columns = [column for _, column in sorted(run_columns)]
    first_data_row = sub_row + 1 if run_columns else header_row + 1

    missing = [name for name in ("id", "title", "steps", "expected") if name not in columns]
    if missing:
        raise ValueError(f"Sheet '{ws.title}': missing columns {', '.join(missing)}.")

    cases = []
    for row in range(first_data_row, ws.max_row + 1):
        case_id = clean(ws.cell(row=row, column=columns["id"]).value)
        if not case_id:
            continue
        values = {name: clean(ws.cell(row=row, column=column).value) for name, column in columns.items()}
        runs = [clean(ws.cell(row=row, column=column).value) for column in run_columns]
        cases.append(RawCase(row=row, values=values, runs=runs))

    return RawSheet(name=ws.title, meta=_sheet_meta(ws, header_row), columns=columns, cases=cases)


def read_test_data(ws: Worksheet) -> list:
    header_row = _find_header_row(ws, "data id")
    if header_row is None:
        return []

    columns = {}
    for cell in ws[header_row]:
        name = DATA_COLUMNS.get(english_label(cell.value) or "")
        if name and name not in columns:
            columns[name] = cell.column

    items = []
    for row in range(header_row + 1, ws.max_row + 1):
        data_id = clean(ws.cell(row=row, column=columns["id"]).value)
        if not data_id:
            continue
        values = {name: clean(ws.cell(row=row, column=column).value) for name, column in columns.items()}
        items.append(RawDataItem(row=row, values=values))
    return items


@dataclass
class RawWorkbook:
    path: Path
    case_sheets: list
    test_data: list


def read_workbook(path: Path, sheets: Optional[list] = None) -> RawWorkbook:
    workbook = load_workbook(path, data_only=False)

    if sheets:
        unknown = [name for name in sheets if name not in workbook.sheetnames]
        if unknown:
            raise ValueError(f"Sheet not found: {', '.join(unknown)}. Sheets: {', '.join(workbook.sheetnames)}")
        case_sheets = [read_case_sheet(workbook[name]) for name in sheets]
    else:
        case_sheets = [read_case_sheet(ws) for ws in workbook.worksheets if is_case_sheet(ws)]
        if not case_sheets:
            raise ValueError(f"No test case sheet (with a '(TC ID)' header) found in {path.name}.")

    test_data = []
    for ws in workbook.worksheets:
        if _find_header_row(ws, "data id") is not None and not is_case_sheet(ws):
            test_data.extend(read_test_data(ws))

    return RawWorkbook(path=Path(path), case_sheets=case_sheets, test_data=test_data)
