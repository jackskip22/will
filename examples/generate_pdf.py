#!/usr/bin/env python3
"""Regenerates willed.pdf to the PDF binding's locked engineered form (WILL-1.md,
"PDF -- non-rendering text-layer marker lines"): one text object, one
baseline, render mode 3 (invisible), placed at the SAME horizontal
reading-flow column as the body text it governs (x=72, not a separate
margin column), on a boundary baseline strictly between two visible
lines -- a marker consumes none of the document's own vertical flow, so
a willed document's visible line positions never depend on how many
markers it carries. The marker font is embedded Unicode TrueType (DejaVu
Sans, plus WenQuanYi Zen Hei for CJK) rather than a base-14 WinAnsi font,
so a marker's law word and intent extract correctly, not merely render
correctly.

This docstring states the form; WILL-1.md's own PDF binding section is
the one place that tells why it looks like this (an earlier carrier's
margin-column clustering and vertical-flow consumption, and why a
base-14 font corrupts extraction, not just rendering) -- git history
carries the rest.

Run from anywhere:  python3 generate_pdf.py
Requires: reportlab (tested at 5.0.1)
"""
import os

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "willed.pdf")
DEFAULT_TWIN_OUT = os.path.join(HERE, "willed.unwilled-twin.pdf")

# DejaVu Sans carries Latin (all blocks), combining diacritics, Greek,
# Cyrillic, Hebrew, Arabic, and a wide swath of Symbol/astral-plane
# glyphs (including many emoji code points) -- everything this
# document's own markers need. It is registered once per process.
MARKER_FONT = "DejaVuSans"
_DEJAVU_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
]
_registered = False


def _find_dejavu_sans():
    for path in _DEJAVU_CANDIDATES:
        if os.path.exists(path):
            return path
    try:
        import subprocess
        out = subprocess.run(
            ["fc-match", "-f", "%{file}", "DejaVu Sans:style=Book"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    raise FileNotFoundError(
        "DejaVu Sans not found (checked " + ", ".join(_DEJAVU_CANDIDATES) + " and fc-match). "
        "The PDF binding's locked form requires a font with a lossless ToUnicode mapping; "
        "install fonts-dejavu-core (Debian/Ubuntu: apt-get install -y fonts-dejavu-core) "
        "and retry."
    )


def _ensure_font_registered():
    global _registered
    if _registered:
        return
    pdfmetrics.registerFont(TTFont(MARKER_FONT, _find_dejavu_sans()))
    _registered = True


LINE_HEIGHT = 20
MARGIN_X = 72  # same left column as visible body text -- no separate
               # marker column for a layout engine to cluster apart.
MARKER_FONT_SIZE = 1  # small: a maximal 512-scalar intent still spans
                       # well under the page width -- see verify_pdf.py
                       # for the measured figure.

# Document structure, in reading order. Markers between two visible
# lines share that gap's boundary band; visible lines get sequential
# slots computed from their own count alone.
ELEMENTS = [
    ("visible", "Ordinary prose an agent may edit freely."),
    ("marker", "<!-- will/1 keep: the sentence legal approved; not ours to improve -->"),
    ("visible", "The approved sentence."),
    ("marker", "<!-- /will -->"),
    ("marker", "<!-- will/1 append: chronological entries only -->"),
    ("visible", "- 2026-01-19 - Partial results are always reported."),
    ("marker", "<!-- /will -->"),
    ("visible", "Closing prose, also free."),
]


def _marker_positions(elements):
    """For each 'marker' element, returns its y in points: strictly
    between the visible line before it and the visible line after it
    (a virtual line one LINE_HEIGHT beyond the first/last visible line
    stands in for "before the first" / "after the last"). Markers
    sharing one gap are spread evenly within it, in document order, so
    two markers between the same pair of visible lines still extract
    in the right relative order. Returns (visible_ys, marker_ys) where
    marker_ys is parallel to the 'marker' elements in ELEMENTS order.
    """
    start_y = letter[1] - 100
    visible_texts = [t for k, t in elements if k == "visible"]
    visible_ys = [start_y - i * LINE_HEIGHT for i in range(len(visible_texts))]

    gaps = []  # gaps[i]: marker texts between visible line i-1 and i (gaps[-1]/[n] are the edges)
    current = []
    for kind, _text in elements:
        if kind == "visible":
            gaps.append(current)
            current = []
        else:
            current.append(_text)
    gaps.append(current)  # trailing markers after the last visible line

    n_visible = len(visible_texts)
    marker_ys = []
    for gi, gap in enumerate(gaps):
        top = visible_ys[gi - 1] if gi > 0 else start_y + LINE_HEIGHT
        bottom = visible_ys[gi] if gi < n_visible else visible_ys[-1] - LINE_HEIGHT
        count = len(gap)
        for k in range(count):
            frac = (k + 1) / (count + 1)
            marker_ys.append(top - frac * (top - bottom))
    return visible_ys, marker_ys


def build(include_markers=True, out_path=None, elements=None):
    """Builds one willed PDF. include_markers=False produces the
    unwilled twin: identical visible lines, identical y positions,
    zero marker text objects -- see verify_pdf.py's structural
    layout-identity proof, which strips the willed stream's invisible
    marker blocks and compares the remainder byte-for-byte against
    this twin's own stream.
    """
    _ensure_font_registered()
    elements = ELEMENTS if elements is None else elements
    out_path = out_path or (DEFAULT_OUT if include_markers else DEFAULT_TWIN_OUT)

    c = canvas.Canvas(out_path, pagesize=letter, invariant=1)
    c.setAuthor("")
    c.setTitle("willed" if include_markers else "willed (unwilled twin)")
    c.setSubject("")
    c.setCreator("")
    c.setProducer("")

    visible_ys, marker_ys = _marker_positions(elements)
    vi = mi = 0
    for kind, text in elements:
        if kind == "visible":
            c.setFont("Helvetica", 12)
            c.drawString(MARGIN_X, visible_ys[vi], text)
            vi += 1
        else:
            if include_markers:
                _draw_marker(c, text, marker_ys[mi])
            mi += 1

    c.showPage()
    c.save()
    return out_path


def _draw_marker(c, text, y):
    """One text object, one baseline, Tr 3, small embedded-Unicode
    font, at the body's own x column. Wrapped in q/Q so the render-mode
    change never leaks into whatever is drawn next -- Tr persists in
    the graphics state across BT/ET, and a writer must restore it."""
    c.saveState()
    to = c.beginText(MARGIN_X, y)
    to.setFont(MARKER_FONT, MARKER_FONT_SIZE)
    to.setLeading(MARKER_FONT_SIZE * 1.2)
    to.setTextRenderMode(3)  # invisible: unpainted, still extractable
    to.textLine(text)
    c.drawText(to)
    c.restoreState()


if __name__ == "__main__":
    willed = build(include_markers=True)
    print("wrote", willed)
    twin = build(include_markers=False)
    print("wrote", twin, "(unwilled twin, for the layout-identity proof)")
