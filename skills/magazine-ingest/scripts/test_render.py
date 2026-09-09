import importlib.util
from contextlib import nullcontext
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("render", pathlib.Path(__file__).with_name("render.py"))
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)


class SandboxTests(unittest.TestCase):
    @unittest.skipUnless(pathlib.Path(render.GS_FALLBACK).is_file() and render.Image is not None, "Ghostscript and Pillow required")
    def test_real_pdf_renders_but_postscript_cannot_write_outside_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            pdf = root / "safe (page).pdf"
            subprocess.run([render.GS_FALLBACK, "-q", "-dBATCH", "-dNOPAUSE", "-dSAFER",
                            "-sDEVICE=pdfwrite", f"-sOutputFile={pdf}", "-c", "showpage"], check=True)
            with patch.object(render.shutil, "which", return_value=None):
                self.assertEqual(render.page_count(str(pdf), render.GS_FALLBACK), 1)
                for name in ["issue:2026.pdf", "issue*.pdf", "-input.pdf"]:
                    renamed = root / name
                    renamed.write_bytes(pdf.read_bytes())
                    self.assertEqual(render.page_count(str(renamed), render.GS_FALLBACK), 1)
            output = root / "pages"
            output.mkdir()
            render.render_ghostscript(render.GS_FALLBACK, str(pdf), [1], str(output), 200)
            self.assertTrue((output / "p-1.jpg").is_file())
            marker = root / "outside.txt"
            source = root / "unsafe.ps"
            source.write_text(f"{render.ps_string(str(marker))} (w) file (unexpected) writestring closefile showpage")
            with self.assertRaises(SystemExit):
                render.render_ghostscript(render.GS_FALLBACK, str(source), [1], str(output), 200)
            self.assertFalse(marker.exists())
            secret = root / "issue-secret.pdf"
            secret.write_text("synthetic test canary")
            source = root / "issue*.pdf"
            source.write_text(f"{render.ps_string(str(secret))} (r) file dup 128 string readline pop == closefile showpage")
            with self.assertRaises(SystemExit):
                render.render_ghostscript(render.GS_FALLBACK, str(source), [1], str(output), 200)

    def test_count_never_retries_without_sandbox(self):
        for result, expected in [(subprocess.CompletedProcess([], 1, "", "denied"), None),
                                 (subprocess.CompletedProcess([], 0, "2\n", ""), 2)]:
            with patch.object(render.shutil, "which", return_value=None), patch.object(render, "ghostscript_workspace", return_value=nullcontext(("/safe/input.pdf", "/safe"))), patch.object(render, "run", return_value=result) as run:
                self.assertEqual(render.page_count("-unusual (name).pdf", "gs"), expected)
                run.assert_called_once()
                args = run.call_args.args[0]
                self.assertIn("-dSAFER", args)
                self.assertNotIn("-dNOSAFER", args)
                self.assertIn("--permit-file-read=/safe/input.pdf", args)

    def test_render_sandbox_and_explicit_failure(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(render, "need_pillow"), patch.object(render, "ghostscript_workspace", return_value=nullcontext(("/safe/input.pdf", tmp))), patch.object(render, "run", return_value=subprocess.CompletedProcess([], 1, "", "denied")) as run:
            with self.assertRaises(SystemExit):
                render.render_ghostscript("gs", "-input.pdf", [2, 3], tmp, 1600)
            args = run.call_args.args[0]
            self.assertIn("-dSAFER", args)
            self.assertNotIn("-dNOSAFER", args)
            self.assertIn("-dFirstPage=2", args)
            self.assertIn("-dLastPage=3", args)
            self.assertEqual(args[-1], "/safe/input.pdf")


if __name__ == "__main__":
    unittest.main()
