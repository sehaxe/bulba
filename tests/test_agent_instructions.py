from pathlib import Path
import unittest


class AgentInstructionsTests(unittest.TestCase):
    def test_session_start_requires_approval_before_running_init_script(self):
        prompt = (Path(__file__).resolve().parents[1] / "agents/bulba.md").read_text()
        session_start = next(
            line for line in prompt.splitlines() if line.startswith("- Session start ")
        )

        self.assertIn("init.sh", session_start)
        self.assertIn("ask the user before running it", session_start)


if __name__ == "__main__":
    unittest.main()
