#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("anticheat-updater.py")
SPEC = importlib.util.spec_from_file_location("anticheat_updater", MODULE_PATH)
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)


class UpdaterTests(unittest.TestCase):
    def test_version_comparison(self):
        self.assertLess(UPDATER.version_tuple("v1.2.3"), UPDATER.version_tuple("1.3.0"))
        self.assertEqual(UPDATER.version_tuple("v2.0.0"), (2, 0, 0))

    def test_install_and_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            source = package / "iw4madmin/Plugins/AnticheatMetrics.js"
            source.parent.mkdir(parents=True)
            source.write_text("new\n", encoding="utf-8")

            destination = root / "live/AnticheatMetrics.js"
            destination.parent.mkdir(parents=True)
            destination.write_text("old\n", encoding="utf-8")

            config = {
                "repository": "owner/repository",
                "stateFile": str(root / "state.json"),
                "backupDirectory": str(root / "backups"),
                "autoApply": {"dashboard": True},
                "targets": {
                    "dashboard": [{
                        "source": "iw4madmin/Plugins/AnticheatMetrics.js",
                        "destination": str(destination),
                    }]
                },
                "restartCommands": {"dashboard": []},
                "healthCheckCommands": [],
            }
            config_path = root / "config.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")

            updater = UPDATER.Updater(config_path)
            updater.install(package, "1.0.0", ["dashboard"])
            self.assertEqual(destination.read_text(encoding="utf-8"), "new\n")
            self.assertEqual(updater.state["componentVersions"]["dashboard"], "1.0.0")

            updater.rollback()
            self.assertEqual(destination.read_text(encoding="utf-8"), "old\n")
            self.assertNotIn("dashboard", updater.state["componentVersions"])

    def test_unsafe_archive_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "bad.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../outside.txt", "bad")
            with self.assertRaises(RuntimeError):
                UPDATER.safe_extract(archive_path, root / "extract")


if __name__ == "__main__":
    unittest.main()
