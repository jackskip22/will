#!/usr/bin/env python3
"""The DOCX binding's acceptance check (WILL-1.md, "DOCX — hidden-text
marker lines"). Regenerates willed.docx and asserts the dual-vanish
locked form structurally, not just by extracting text: every marker
paragraph's own run AND its paragraph mark's run properties (`pPr/rPr`)
both carry `w:vanish`, and python-docx extraction feeds
reference/will.mjs to exactly two regions, zero faults.

Run from examples/:  python3 verify_docx.py
Requires: python-docx (tested at 1.2.0)
"""
import json
import os
import re
import subprocess
import sys
import zipfile

import docx

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_docx  # noqa: E402  (local module; sys.path adjusted above)

WILL_MJS = os.path.join(HERE, "..", "reference", "will.mjs")
DOCX_PATH = os.path.join(HERE, "willed.docx")

failures = []


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def will_parse(text):
    # "-" reads fd 0 (stdin) portably in will.mjs's own CLI -- no
    # dependence on a platform actually exposing "/dev/stdin".
    proc = subprocess.run(
        ["node", WILL_MJS, "parse", "-"],
        input=text.encode("utf-8"), capture_output=True, check=True,
    )
    return json.loads(proc.stdout)


def check_dual_vanish_structurally():
    print("=== structural dual-vanish check ===")
    with zipfile.ZipFile(DOCX_PATH) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paras = re.findall(r'<w:p\b.*?</w:p>', xml, re.DOTALL)
    # word/document.xml XML-escapes "<!--"/"-->" as "&lt;!--"/"--&gt;", so
    # match the angle-bracket-free substrings that survive escaping.
    marker_paras = [p for p in paras if "will/1" in p or "/will" in p]
    check("exactly 4 marker paragraphs found in word/document.xml",
          len(marker_paras) == 4, f"got {len(marker_paras)}")
    for i, p in enumerate(marker_paras):
        run_vanish = bool(re.search(r'<w:r>\s*<w:rPr>(?:(?!</w:rPr>).)*<w:vanish/>', p, re.DOTALL))
        ppr_vanish = bool(re.search(r'<w:pPr>\s*<w:rPr>(?:(?!</w:pPr>).)*<w:vanish/>', p, re.DOTALL))
        check(f"marker paragraph {i}: run carries w:vanish", run_vanish)
        check(f"marker paragraph {i}: paragraph mark (pPr/rPr) carries w:vanish", ppr_vanish)
    # No stray customXml part (generate_docx.py's own honesty claim).
    with zipfile.ZipFile(DOCX_PATH) as z:
        names = z.namelist()
    check("no stray customXml part shipped", not any(n.startswith("customXml/") for n in names),
          f"found: {[n for n in names if n.startswith('customXml/')]}")


def check_extraction():
    print("=== python-docx extraction -> will.mjs parse ===")
    d = docx.Document(DOCX_PATH)
    text = "\n".join(p.text for p in d.paragraphs)
    parsed = will_parse(text)
    check("0 faults", parsed["faults"] == [], f"faults={parsed['faults']}")
    check("exactly 2 regions", len(parsed["regions"]) == 2, f"got {len(parsed['regions'])}")


def check_pandoc_roundtrip():
    print("=== pandoc -t plain round-trip ===")
    from shutil import which
    if which("pandoc") is None:
        print("[NOTE] pandoc not installed; round-trip check skipped")
        return
    proc = subprocess.run(["pandoc", "-t", "plain", DOCX_PATH], capture_output=True, check=True)
    text = proc.stdout.decode("utf-8")
    parsed = will_parse(text)
    # pandoc's plain writer reflows long lines at its own column width --
    # a conversion under the reflow rule (WILL-1.md), not a carrier
    # failure -- so this checks marker recovery, not byte-exact governed
    # content.
    check("pandoc round-trip: markers recovered (2 regions, 0 faults)",
          parsed["faults"] == [] and len(parsed["regions"]) == 2,
          f"faults={parsed['faults']} regions={len(parsed['regions'])}")


def main():
    written = generate_docx.build()
    print("regenerated", written)
    check_dual_vanish_structurally()
    check_extraction()
    check_pandoc_roundtrip()
    print(f"\n{len(failures)} failing assertion(s).")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
