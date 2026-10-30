"""Gitleaks is downloaded from its official GitHub release, with a pinned checksum."""

import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

version = "8.30.0"
assert platform.system() == "Linux" and platform.machine() == "x86_64"
base = f"https://github.com/gitleaks/gitleaks/releases/download/v{version}/"
name = f"gitleaks_{version}_linux_x64.tar.gz"
with tempfile.TemporaryDirectory() as temp:
    archive = Path(temp) / name
    urllib.request.urlretrieve(base + name, archive)
    expected = "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
    with tarfile.open(archive) as package:
        binary = package.getmember("gitleaks")
        assert binary.isfile()
        package.extract(binary, temp, filter="data")
    scanner = Path(temp) / "gitleaks"
    scanner.chmod(0o700)
    # Scan current source plus all reachable commits, without writing secret-bearing findings.
    for args in [["git", "--log-opts=--all"]]:
        subprocess.run(
            [str(scanner), *args, "--config=.gitleaks.toml", "--redact=100", "--no-banner"],
            check=True,
            env={**os.environ, "GITLEAKS_ENABLE_COMMENTS": "false"},
        )
