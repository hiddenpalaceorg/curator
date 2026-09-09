import pathlib
import os
import subprocess
import tempfile
import unittest


class DeployRefTests(unittest.TestCase):
    def test_production_job_only_accepts_main(self):
        workflow = pathlib.Path(__file__).parents[1] / "workflows" / "deploy-hpwiki.yml"
        lines = workflow.read_text().splitlines()
        self.assertIn("    needs: authorize", lines)
        self.assertIn("    if: needs.authorize.outputs.allowed == 'true'", lines)
        start = lines.index("        run: |") + 1
        script = []
        for line in lines[start:]:
            if not line.startswith("          "):
                break
            script.append(line[10:])
        for ref in ["refs/heads/main", "refs/heads/Main", "refs/heads/MAIN", "refs/heads/feature", "refs/tags/main"]:
            with tempfile.TemporaryDirectory() as tmp:
                output = pathlib.Path(tmp) / "output"
                result = subprocess.run(["bash", "-e", "-c", "\n".join(script)],
                    env={**os.environ, "DEPLOY_REF": ref, "GITHUB_OUTPUT": str(output)})
                self.assertEqual(result.returncode == 0, ref == "refs/heads/main")
                self.assertEqual(output.read_text() if output.exists() else "", "allowed=true\n" if ref == "refs/heads/main" else "")


if __name__ == "__main__":
    unittest.main()
