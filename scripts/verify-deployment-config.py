"""Credential-free structural validation for checked-in deployment configuration."""

from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent.parent
YAML_FILES = (
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-fly.yml",
    ".github/workflows/rollback.yml",
    "docker-compose.yml",
)
TOML_FILES = ("fly.review-dashboard.toml", "fly.marketing-site.toml")


def fail(message: str) -> None:
    raise RuntimeError(f"Deployment configuration validation failed: {message}")


def main() -> None:
    for relative_path in YAML_FILES:
        path = ROOT / relative_path
        if not isinstance(yaml.safe_load(path.read_text(encoding="utf-8")), dict):
            fail(f"{relative_path} must be a YAML mapping")

    for relative_path in TOML_FILES:
        path = ROOT / relative_path
        if not isinstance(tomllib.loads(path.read_text(encoding="utf-8")), dict):
            fail(f"{relative_path} must be a TOML mapping")

    # `docker compose config` resolves/interpolates the real Compose model and
    # does not need a running Docker daemon. It catches schema errors that a
    # generic YAML parser cannot.
    subprocess.run(
        ["docker", "compose", "config", "--quiet"],
        cwd=ROOT,
        check=True,
    )
    print("Deployment configuration structure verified: YAML, TOML, and Docker Compose.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError, tomllib.TOMLDecodeError, yaml.YAMLError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
