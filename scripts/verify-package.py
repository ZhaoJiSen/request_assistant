"""Verify the CI ZIP against its version and compiled extension files."""

import json
import os
from pathlib import Path
from zipfile import ZipFile

version = os.environ["VERSION"]
root = Path.cwd()
output = root / ".output" / "chrome-mv3"
archive = root / ".output" / f"request-helper-{version}-chrome.zip"

with ZipFile(archive) as package:
    names = [name for name in package.namelist() if not name.endswith("/")]
    assert len(names) == len(set(names)), "ZIP contains duplicate file names"
    assert {"manifest.json", "popup.html", "background.js"} <= set(names), "Missing extension entrypoints at ZIP root"
    manifest = json.loads(package.read("manifest.json"))
    assert manifest["version"] == version, "Manifest version differs from input"
    assert manifest["manifest_version"] == 3, "Expected Manifest V3"
    assert manifest["name"] == "请求助手", "Unexpected extension name"
    expected = {p.relative_to(output).as_posix(): p for p in output.rglob("*") if p.is_file()}
    assert set(names) == set(expected), "ZIP does not match compiled extension"
    for name, path in expected.items():
        assert package.read(name) == path.read_bytes(), f"ZIP differs: {name}"
    assert package.testzip() is None, "ZIP integrity check failed"

print(f"Verified {archive.name}: version {version}, {len(names)} files")
