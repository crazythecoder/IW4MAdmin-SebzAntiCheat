#!/usr/bin/env python3
"""Safe GitHub Release updater for the IW4X anti-cheat package."""

import argparse
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import re
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ASSET_NAME = "iw4x-anticheat-release.zip"
CHECKSUM_NAME = ASSET_NAME + ".sha256"
USER_AGENT = "IW4X-Anticheat-Updater/1.0"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, path)


def version_tuple(value):
    clean = str(value or "0").strip().lstrip("vV").split("-", 1)[0]
    parts = []
    for piece in clean.split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return tuple((parts + [0, 0, 0])[:3])


def request_bytes(url, token=None):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def latest_release(repository, token=None):
    url = "https://api.github.com/repos/{}/releases/latest".format(repository)
    return json.loads(request_bytes(url, token).decode("utf-8"))


def release_asset(release, name):
    for asset in release.get("assets", []):
        if asset.get("name") == name:
            return asset.get("browser_download_url")
    raise RuntimeError("Release asset '{}' is missing".format(name))


def safe_extract(archive_path, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive_path, "r") as archive:
        for member in archive.infolist():
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise RuntimeError("Release archive contains a symbolic link")
            target = (destination / member.filename).resolve()
            if target != destination and destination not in target.parents:
                raise RuntimeError("Unsafe path in release archive: {}".format(member.filename))
        archive.extractall(destination)


def run_commands(commands, label):
    for command in commands or []:
        if not isinstance(command, list) or not command:
            raise RuntimeError("{} command must be a non-empty JSON array".format(label))
        print("Running {}: {}".format(label, " ".join(shlex.quote(str(part)) for part in command)))
        subprocess.run([str(part) for part in command], check=True)


def run_health_checks(checks):
    for check in checks or []:
        name = str(check.get("name") or "health check")
        command = check.get("command")
        repair_commands = check.get("repairCommands", [])
        expected_output = check.get("expectedOutput")
        attempts = max(1, int(check.get("attempts", 3)))
        delay = max(0, float(check.get("delaySeconds", 5)))
        if not isinstance(command, list) or not command:
            raise RuntimeError("{} command must be a non-empty JSON array".format(name))

        def attempt_check():
            for attempt in range(1, attempts + 1):
                print("Running {} ({}/{})".format(name, attempt, attempts))
                result = subprocess.run([str(part) for part in command], check=False, capture_output=True, text=True)
                output_matches = expected_output is None or re.search(str(expected_output), result.stdout.strip(), re.IGNORECASE)
                if result.returncode == 0 and output_matches:
                    return True
                if result.stderr.strip():
                    print(result.stderr.strip(), file=sys.stderr)
                if attempt < attempts and delay:
                    time.sleep(delay)
            return False

        if attempt_check():
            continue
        if repair_commands:
            run_commands(repair_commands, name + " repair")
            if attempt_check():
                continue
        raise RuntimeError("{} failed after {} attempts".format(name, attempts))


class Updater:
    def __init__(self, config_path, apply_all=False, force=False):
        self.config_path = Path(config_path)
        self.config = read_json(self.config_path)
        self.state_path = Path(self.config.get("stateFile", "/var/lib/iw4x-anticheat-updater/state.json"))
        self.dashboard_history_path = self.resolve_dashboard_history_path()
        self.backup_root = Path(self.config.get("backupDirectory", "/var/lib/iw4x-anticheat-updater/backups"))
        self.apply_all = apply_all
        self.force = force
        self.state = self.load_state()
        self.validate_configuration()

    def resolve_dashboard_history_path(self):
        configured = self.config.get("dashboardHistoryFile")
        if configured:
            return Path(configured)
        for target in self.config.get("targets", {}).get("dashboard", []):
            destination = Path(str(target.get("destination", "")))
            if destination.name and destination.parent.name.lower() == "plugins":
                return destination.parent.parent / "Logs" / "anticheat-update-history.json"
        return Path("/var/lib/iw4x-anticheat-updater/update-history.json")

    def validate_configuration(self):
        repository = str(self.config.get("repository") or "")
        if "/" not in repository:
            raise RuntimeError("repository must use the owner/name format")
        for component, targets in self.config.get("targets", {}).items():
            if not isinstance(targets, list):
                raise RuntimeError("targets.{} must be a JSON array".format(component))
            for target in targets:
                if not target.get("source") or not target.get("destination"):
                    raise RuntimeError("Each {} target needs source and destination".format(component))

    def initialize_directories(self):
        for entry in self.config.get("initialization", {}).get("directories", []):
            path = Path(entry["path"])
            path.mkdir(parents=True, exist_ok=True)
            if entry.get("mode"):
                os.chmod(path, int(str(entry["mode"]), 8))

    def initialize_seed_files(self, package_root, manifest):
        for entry in self.config.get("initialization", {}).get("seedFiles", []):
            source = package_root / entry["source"]
            destination = Path(entry["destination"])
            if destination.exists():
                continue
            if not source.is_file():
                raise RuntimeError("Initialization seed file is missing: {}".format(entry["source"]))
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
                temp_path = Path(handle.name)
            shutil.copyfile(source, temp_path)
            os.chmod(temp_path, int(str(entry.get("mode", "640")), 8))
            os.replace(temp_path, destination)
            manifest["files"].append({
                "component": "initialization",
                "destination": str(destination),
                "existed": False,
                "backup": None,
            })

    def run_operational_checks(self):
        run_commands(self.config.get("healthCheckCommands", []), "health check")
        run_health_checks(self.config.get("healthChecks", []))

    def load_state(self):
        if not self.state_path.exists():
            return {"componentVersions": {}, "lastCheck": None, "lastSuccess": None}
        try:
            return read_json(self.state_path)
        except (OSError, ValueError):
            return {"componentVersions": {}, "lastCheck": None, "lastSuccess": None}

    def save_state(self):
        write_json_atomic(self.state_path, self.state)
        try:
            write_json_atomic(self.dashboard_history_path, {
                "latestVersion": self.state.get("latestVersion"),
                "lastCheck": self.state.get("lastCheck"),
                "lastSuccess": self.state.get("lastSuccess"),
                "lastError": self.state.get("lastError"),
                "history": self.state.get("history", []),
            })
        except OSError as error:
            print("Warning: dashboard update history could not be written: {}".format(error), file=sys.stderr)

    def record_history(self, status, title, detail, version=None, components=None, restart_required=False):
        history = self.state.setdefault("history", [])
        history.insert(0, {
            "id": "{}-{}".format(int(time.time() * 1000), len(history)),
            "timestamp": utc_now(),
            "status": status,
            "title": title,
            "detail": detail,
            "version": version,
            "components": list(components or []),
            "restartRequired": bool(restart_required),
        })
        del history[100:]
        self.save_state()

    def requires_iw4madmin_restart(self, components):
        for component in components or []:
            if "dashboard" in component.lower() or "iw4madmin" in component.lower():
                return True
            for target in self.config.get("targets", {}).get(component, []):
                if "iw4madmin" in str(target.get("destination", "")).lower():
                    return True
        return False

    def selected_components(self):
        selected = []
        auto_apply = self.config.get("autoApply", {})
        for component, targets in self.config.get("targets", {}).items():
            if targets and (self.apply_all or auto_apply.get(component, False)):
                selected.append(component)
        return selected

    def check_release(self):
        token = os.environ.get("GITHUB_TOKEN")
        release = latest_release(self.config["repository"], token)
        version = str(release.get("tag_name", "")).lstrip("vV")
        if not version:
            raise RuntimeError("Latest GitHub release has no version tag")
        self.state["lastCheck"] = utc_now()
        self.state["latestVersion"] = version
        self.save_state()
        return release, version, token

    def pending_components(self, version):
        versions = self.state.setdefault("componentVersions", {})
        return [
            component for component in self.selected_components()
            if self.force or version_tuple(versions.get(component)) < version_tuple(version)
        ]

    def download_release(self, release, token, work_dir):
        archive_url = release_asset(release, ASSET_NAME)
        checksum_url = release_asset(release, CHECKSUM_NAME)
        archive_path = Path(work_dir) / ASSET_NAME
        archive_path.write_bytes(request_bytes(archive_url, token))
        checksum_text = request_bytes(checksum_url, token).decode("utf-8").strip()
        expected = checksum_text.split()[0].lower()
        actual = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        if expected != actual:
            raise RuntimeError("Release checksum verification failed")
        return archive_path

    def install(self, package_root, version, components):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_dir = self.backup_root / "{}-{}".format(version, stamp)
        backup_files = backup_dir / "files"
        backup_files.mkdir(parents=True, exist_ok=False)
        manifest = {
            "version": version,
            "createdAt": utc_now(),
            "previousComponentVersions": dict(self.state.get("componentVersions", {})),
            "files": [],
        }
        changed_components = []

        try:
            self.initialize_directories()
            self.initialize_seed_files(package_root, manifest)
            run_commands(self.config.get("initialization", {}).get("commands", []), "initialization")
            for component in components:
                targets = self.config.get("targets", {}).get(component, [])
                for index, target in enumerate(targets):
                    source = package_root / target["source"]
                    destination = Path(target["destination"])
                    if not source.is_file():
                        raise RuntimeError("Package file is missing: {}".format(target["source"]))

                    record = {
                        "component": component,
                        "destination": str(destination),
                        "existed": destination.exists(),
                        "backup": None,
                    }
                    if destination.exists():
                        backup_path = backup_files / "{:04d}".format(len(manifest["files"]))
                        shutil.copy2(destination, backup_path)
                        record["backup"] = str(backup_path)

                    destination.parent.mkdir(parents=True, exist_ok=True)
                    existing_mode = stat.S_IMODE(destination.stat().st_mode) if destination.exists() else None
                    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
                        temp_path = Path(handle.name)
                    shutil.copyfile(source, temp_path)
                    os.chmod(temp_path, existing_mode if existing_mode is not None else stat.S_IMODE(source.stat().st_mode))
                    os.replace(temp_path, destination)
                    manifest["files"].append(record)

                changed_components.append(component)

            write_json_atomic(backup_dir / "manifest.json", manifest)
            run_commands(self.config.get("validationCommands", []), "validation")
            for component in changed_components:
                run_commands(self.config.get("restartCommands", {}).get(component, []), component)
            self.run_operational_checks()
        except Exception:
            print("Update failed; restoring files from {}".format(backup_dir), file=sys.stderr)
            self.restore_manifest(manifest)
            for component in changed_components:
                try:
                    run_commands(self.config.get("restartCommands", {}).get(component, []), component + " rollback")
                except (OSError, subprocess.CalledProcessError, RuntimeError) as restart_error:
                    print("Rollback restart failed for {}: {}".format(component, restart_error), file=sys.stderr)
            raise

        versions = self.state.setdefault("componentVersions", {})
        for component in changed_components:
            versions[component] = version
        self.state["lastSuccess"] = utc_now()
        self.state["lastBackup"] = str(backup_dir)
        self.state["lastError"] = None
        self.save_state()
        return backup_dir

    @staticmethod
    def restore_manifest(manifest):
        for record in reversed(manifest.get("files", [])):
            destination = Path(record["destination"])
            backup = record.get("backup")
            if record.get("existed") and backup and Path(backup).exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, destination)
            elif not record.get("existed") and destination.exists():
                destination.unlink()

    def rollback(self):
        backup_name = self.config.get("rollbackBackup") or self.state.get("lastBackup")
        if not backup_name:
            raise RuntimeError("No backup is available for rollback")
        manifest = read_json(Path(backup_name) / "manifest.json")
        self.restore_manifest(manifest)
        components = sorted({item["component"] for item in manifest.get("files", [])})
        for component in components:
            run_commands(self.config.get("restartCommands", {}).get(component, []), component)
        self.state["componentVersions"] = dict(manifest.get("previousComponentVersions", {}))
        self.state["lastRollback"] = utc_now()
        self.save_state()
        print("Restored backup {}".format(backup_name))

    def apply(self, check_only=False):
        self.initialize_directories()
        self.record_history("checking", "Checking for updates", "Contacting GitHub Releases for the latest stable anti-cheat package.")
        release, version, token = self.check_release()
        pending = self.pending_components(version)
        if not pending:
            self.record_history("current", "No update available", "All enabled anti-cheat components are current.", version=version)
            print("Anti-cheat components are current at release v{}".format(version))
            if not check_only:
                run_commands(self.config.get("maintenanceCommands", []), "maintenance")
                self.run_operational_checks()
            return
        restart_required = self.requires_iw4madmin_restart(pending)
        self.record_history(
            "available",
            "New update detected",
            "Release v{} is available for {}.".format(version, ", ".join(pending)),
            version=version,
            components=pending,
            restart_required=restart_required,
        )
        print("Release v{} is available for: {}".format(version, ", ".join(pending)))
        if check_only:
            return

        with tempfile.TemporaryDirectory(prefix="iw4x-anticheat-update-") as work_dir:
            try:
                archive = self.download_release(release, token, work_dir)
            except Exception as error:
                self.record_history("failed", "Update download failed", str(error), version=version, components=pending)
                raise
            self.record_history(
                "staged",
                "Update staged",
                "Release v{} downloaded and passed checksum verification.".format(version),
                version=version,
                components=pending,
                restart_required=restart_required,
            )
            extract_dir = Path(work_dir) / "package"
            extract_dir.mkdir()
            safe_extract(archive, extract_dir)
            if not (extract_dir / "VERSION").is_file():
                raise RuntimeError("Release package has no VERSION file")
            packaged_version = (extract_dir / "VERSION").read_text(encoding="utf-8").strip()
            if version_tuple(packaged_version) != version_tuple(version):
                raise RuntimeError("Release tag and packaged VERSION do not match")
            self.record_history(
                "installing",
                "Applying update",
                "Installing {} from release v{}.".format(", ".join(pending), version),
                version=version,
                components=pending,
                restart_required=restart_required,
            )
            try:
                backup = self.install(extract_dir, version, pending)
            except Exception as error:
                self.record_history("failed", "Update installation failed", str(error), version=version, components=pending)
                raise
        restart_detail = " IW4MAdmin was restarted by the updater when a restart command was configured; otherwise restart it to load the dashboard update." if restart_required else ""
        self.record_history(
            "applied",
            "Update successfully applied",
            "Updated {} to v{}.{}".format(", ".join(pending), version, restart_detail),
            version=version,
            components=pending,
            restart_required=restart_required,
        )
        print("Updated {} to v{}. Backup: {}".format(", ".join(pending), version, backup))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/iw4x-anticheat-updater.json")
    parser.add_argument("--check", action="store_true", help="check without installing")
    parser.add_argument("--apply-all", action="store_true", help="also apply components disabled in autoApply")
    parser.add_argument("--force", action="store_true", help="reinstall the latest release")
    parser.add_argument("--rollback", action="store_true", help="restore the most recent backup")
    args = parser.parse_args()

    updater = None
    try:
        updater = Updater(args.config, apply_all=args.apply_all, force=args.force)
        if args.rollback:
            updater.rollback()
        else:
            updater.apply(check_only=args.check)
    except (KeyError, OSError, RuntimeError, ValueError, urllib.error.URLError, subprocess.CalledProcessError) as error:
        if updater is not None:
            updater.state["lastFailure"] = utc_now()
            updater.state["lastError"] = str(error)
            try:
                latest = (updater.state.get("history") or [{}])[0]
                if latest.get("status") == "failed":
                    updater.save_state()
                else:
                    updater.record_history("failed", "Update check failed", str(error))
            except OSError:
                pass
        print("Anti-cheat updater error: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
