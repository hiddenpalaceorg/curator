#!/usr/bin/env python3
"""Render magazine PDF pages to analysis JPEGs plus gridded copies. See SKILL.md.

  render.py <pdf> <workdir> [--dpi-target 1600] [--grid-only] [--pages A-B]

Writes <workdir>/pages/p-<n>.jpg (n = 1-based pdf index, long edge ~1600px)
and <workdir>/grid/p-<n>.jpg (the same render with a semi-transparent 10x10
grid and 0.1..0.9 coordinate labels for reading normalized bboxes).

Renderer: pdftoppm (poppler) when available, else Ghostscript — resolved from
$GHOSTSCRIPT_BIN, then `gs`, then /opt/homebrew/opt/ghostscript/bin/gs; each
candidate's -h banner must actually say Ghostscript (on macOS a bare `gs` is
often git-spice).

Idempotent: pages already in pages/ are not re-rendered and grids already in
grid/ are not redrawn (--grid-only forces grid redraw from existing pages).

Run under `uv run --no-project --with pillow python3 render.py ...`; plain
python3 works too when Pillow is installed.
"""

import argparse
from contextlib import contextmanager
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # error at use time, so --help works anywhere
    Image = None

GS_FALLBACK = "/opt/homebrew/opt/ghostscript/bin/gs"
GS_RENDER_DPI = 200  # then downscaled to the long-edge target with Pillow
JPEG_QUALITY = 88

def note(msg):
    print(msg, file=sys.stderr)

def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)

def need_pillow():
    if Image is None:
        die("Pillow is required: run under `uv run --no-project --with pillow python3 ...`")

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

# ── renderer resolution ──────────────────────────────────────────────────────

def find_pdftoppm():
    return shutil.which("pdftoppm")

def is_ghostscript(binary):
    """The -h banner of real Ghostscript names it; git-spice's does not."""
    try:
        r = run([binary, "-h"], timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "ghostscript" in (r.stdout + r.stderr).lower()

def find_ghostscript():
    env = os.environ.get("GHOSTSCRIPT_BIN", "").strip()
    candidates = [env] if env else []
    candidates += ["gs", GS_FALLBACK]
    for c in candidates:
        binary = c if os.path.sep in c else shutil.which(c)
        if binary and is_ghostscript(binary):
            return binary
        if c == env:
            note(f"warning: GHOSTSCRIPT_BIN={env!r} is not Ghostscript; trying fallbacks")
    return None

# ── page count ───────────────────────────────────────────────────────────────

def ps_string(path):
    return "(" + re.sub(r"([\\()])", r"\\\1", path) + ")"

@contextmanager
def ghostscript_workspace(pdf):
    # Ghostscript treats permission paths as patterns and ':' as a list
    # separator. Never grant permissions using an input-controlled filename.
    with tempfile.TemporaryDirectory(prefix="magazine-render-") as work:
        source = os.path.join(work, "input.pdf")
        shutil.copyfile(pdf, source)
        yield source, work

def page_count(pdf, gs):
    pdf = os.path.abspath(pdf)
    pdfinfo = shutil.which("pdfinfo")
    if pdfinfo:
        r = run([pdfinfo, pdf], timeout=120)
        m = re.search(r"^Pages:\s+(\d+)", r.stdout, re.M)
        if m:
            return int(m.group(1))
    if gs:
        with ghostscript_workspace(pdf) as (source, _):
            script = f"{ps_string(source)} (r) file runpdfbegin pdfpagecount = quit"
            r = run([gs, "-q", "-dNODISPLAY", "-dSAFER", "-P-",
                     f"--permit-file-read={source}", "-c", script], timeout=300)
            m = re.search(r"^\s*(\d+)\s*$", r.stdout, re.M)
            if r.returncode == 0 and m:
                return int(m.group(1))
    return None

# ── rendering ────────────────────────────────────────────────────────────────

def contiguous_runs(pages):
    runs, start, prev = [], None, None
    for n in sorted(pages):
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            runs.append((start, prev))
            start = prev = n
    if start is not None:
        runs.append((start, prev))
    return runs

def collect_rendered(tmp, pages_dir, wanted):
    """Move tmp/page-<n>.jpg (renderer numbering) into pages/p-<n>.jpg."""
    got = []
    for name in sorted(os.listdir(tmp)):
        m = re.search(r"(\d+)\.jpe?g$", name)
        if not m:
            continue
        n = int(m.group(1))
        if n not in wanted:
            note(f"warning: unexpected render {name}; ignoring")
            continue
        os.replace(os.path.join(tmp, name), os.path.join(pages_dir, f"p-{n}.jpg"))
        got.append(n)
    return got

def render_pdftoppm(binary, pdf, pages, pages_dir, target):
    for first, last in contiguous_runs(pages):
        note(f"pdftoppm: pages {first}-{last}")
        tmp = os.path.join(pages_dir, ".tmp-render")
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        base = [binary, "-f", str(first), "-l", str(last), "-jpeg",
                "-scale-to", str(target), pdf, os.path.join(tmp, "page")]
        r = run(base[:7] + ["-jpegopt", f"quality={JPEG_QUALITY}"] + base[7:], timeout=3600)
        if r.returncode:  # older poppler without -jpegopt
            r = run(base, timeout=3600)
        if r.returncode:
            die(f"pdftoppm failed on pages {first}-{last}: {r.stderr.strip()[:500]}")
        got = collect_rendered(tmp, pages_dir, set(range(first, last + 1)))
        shutil.rmtree(tmp, ignore_errors=True)
        missing = set(range(first, last + 1)) - set(got)
        if missing:
            die(f"pdftoppm produced no output for pages {sorted(missing)}")

def render_ghostscript(binary, pdf, pages, pages_dir, target):
    need_pillow()  # gs renders at fixed dpi; Pillow normalizes the long edge
    with ghostscript_workspace(pdf) as (source, work):
        _render_ghostscript(binary, source, pages, pages_dir, target, work)

def _render_ghostscript(binary, pdf, pages, pages_dir, target, work):
    for first, last in contiguous_runs(pages):
        note(f"ghostscript: pages {first}-{last}")
        tmp = os.path.join(work, "pages")
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        r = run([binary, "-dBATCH", "-dNOPAUSE", "-dQUIET", "-dSAFER", "-P-",
                 "-sDEVICE=jpeg", f"-dJPEGQ={JPEG_QUALITY}", f"-r{GS_RENDER_DPI}",
                 "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
                 f"-dFirstPage={first}", f"-dLastPage={last}",
                 f"-sOutputFile={os.path.join(tmp, 'page-%d.jpg')}", pdf], timeout=3600)
        if r.returncode:
            die(f"ghostscript failed on pages {first}-{last}: {r.stderr.strip()[:500]}")
        # gs numbers output from 1 within the run; rename to absolute indices.
        for name in sorted(os.listdir(tmp)):
            m = re.fullmatch(r"page-(\d+)\.jpg", name)
            if not m:
                continue
            n = first + int(m.group(1)) - 1
            if n > last:
                continue
            src = os.path.join(tmp, name)
            with Image.open(src) as im:
                long_edge = max(im.size)
                if long_edge > target:
                    scale = target / long_edge
                    im = im.resize((max(1, round(im.width * scale)),
                                    max(1, round(im.height * scale))), Image.LANCZOS)
                im.convert("RGB").save(os.path.join(pages_dir, f"p-{n}.jpg"),
                                       quality=JPEG_QUALITY)
            os.remove(src)
        shutil.rmtree(tmp, ignore_errors=True)
        missing = [n for n in range(first, last + 1)
                   if not os.path.exists(os.path.join(pages_dir, f"p-{n}.jpg"))]
        if missing:
            die(f"ghostscript produced no output for pages {missing}")

# ── grid overlay ─────────────────────────────────────────────────────────────

def grid_font(size):
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()

def draw_grid(src, dst):
    need_pillow()
    with Image.open(src) as im:
        base = im.convert("RGBA")
    w, h = base.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    line = (255, 0, 255, 110)
    width = max(1, round(min(w, h) / 800))
    font = grid_font(max(14, round(min(w, h) / 70)))
    for i in range(1, 10):
        f = i / 10
        x, y = round(f * w), round(f * h)
        d.line([(x, 0), (x, h)], fill=line, width=width)
        d.line([(0, y), (w, y)], fill=line, width=width)
        label = f"0.{i}"
        kw = dict(fill=(200, 0, 200, 255), stroke_width=2,
                  stroke_fill=(255, 255, 255, 255), font=font)
        d.text((x + 3, 2), label, **kw)          # top edge: x labels
        d.text((3, y + 2), label, **kw)          # left edge: y labels
    out = Image.alpha_composite(base, overlay).convert("RGB")
    out.save(dst, quality=80)

# ── main ─────────────────────────────────────────────────────────────────────

def parse_pages(spec, total):
    if not spec:
        if total is None:
            die("could not determine the page count; pass --pages A-B")
        return list(range(1, total + 1))
    m = re.fullmatch(r"(\d+)(?:-(\d+))?", spec)
    if not m:
        die("--pages must be N or A-B (1-based, inclusive)")
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else a
    if a < 1 or b < a:
        die("--pages range is empty")
    if total is not None and b > total:
        die(f"--pages {spec} exceeds the {total}-page document")
    return list(range(a, b + 1))

def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("pdf", help="source magazine PDF")
    p.add_argument("workdir", help="per-issue work dir (pages/ and grid/ created inside)")
    p.add_argument("--dpi-target", type=int, default=1600, metavar="PX",
                   help="long-edge pixel target for the renders (default 1600)")
    p.add_argument("--grid-only", action="store_true",
                   help="skip rendering; (re)draw grids from existing pages/*.jpg")
    p.add_argument("--pages", metavar="A-B", help="only this 1-based page range")
    args = p.parse_args()

    args.pdf = os.path.abspath(args.pdf)
    args.workdir = os.path.abspath(args.workdir)

    if not os.path.isfile(args.pdf):
        die(f"no such file: {args.pdf}")
    pages_dir = os.path.join(args.workdir, "pages")
    grid_dir = os.path.join(args.workdir, "grid")
    os.makedirs(pages_dir, exist_ok=True)
    os.makedirs(grid_dir, exist_ok=True)

    pdftoppm = find_pdftoppm()
    gs = None if pdftoppm else find_ghostscript()
    if not args.grid_only and not pdftoppm and not gs:
        die("no PDF renderer: install poppler (pdftoppm) or Ghostscript "
            "(set GHOSTSCRIPT_BIN if `gs` resolves to something else)")

    if args.grid_only:
        if args.pages:
            pages = parse_pages(args.pages, None)
        else:
            pages = sorted(int(m.group(1)) for f in os.listdir(pages_dir)
                           if (m := re.fullmatch(r"p-(\d+)\.jpg", f)))
            if not pages:
                die(f"no rendered pages in {pages_dir}; run without --grid-only first")
    else:
        total = page_count(args.pdf, gs or find_ghostscript())
        pages = parse_pages(args.pages, total)

    if not args.grid_only:
        todo = [n for n in pages
                if not os.path.exists(os.path.join(pages_dir, f"p-{n}.jpg"))]
        if not todo:
            note("all requested pages already rendered")
        elif pdftoppm:
            render_pdftoppm(pdftoppm, args.pdf, todo, pages_dir, args.dpi_target)
        else:
            render_ghostscript(gs, args.pdf, todo, pages_dir, args.dpi_target)

    drawn = 0
    for n in pages:
        src = os.path.join(pages_dir, f"p-{n}.jpg")
        dst = os.path.join(grid_dir, f"p-{n}.jpg")
        if not os.path.exists(src):
            note(f"warning: no render for page {n}; skipping its grid")
            continue
        if os.path.exists(dst) and not args.grid_only:
            continue
        draw_grid(src, dst)
        drawn += 1

    done = sum(1 for n in pages if os.path.exists(os.path.join(pages_dir, f"p-{n}.jpg")))
    print(f"pages: {done}/{len(pages)} rendered in {pages_dir}")
    print(f"grid: {drawn} drawn this run in {grid_dir}")

if __name__ == "__main__":
    main()
