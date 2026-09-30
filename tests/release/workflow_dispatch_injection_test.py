import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ("public-release.yml", "public-unsigned-beta.yml", "store-release.yml")


class WorkflowDispatchInjectionTests(unittest.TestCase):
    def test_dispatch_inputs_are_not_expanded_inside_executable_scripts(self):
        for name in WORKFLOWS:
            lines = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8").splitlines()
            with self.subTest(workflow=name):
                for index, line in enumerate(lines):
                    indent = len(line) - len(line.lstrip())
                    if not line.lstrip().startswith("run:"):
                        continue
                    script = [line]
                    for following in lines[index + 1:]:
                        if following.strip() and len(following) - len(following.lstrip()) <= indent:
                            break
                        script.append(following)
                    self.assertNotIn("${{ inputs.", "\n".join(script), f"run block at {name}:{index + 1}")


if __name__ == "__main__":
    unittest.main()
