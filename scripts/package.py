"""Build a load-unpacked archive without including dependencies or collected data."""
from pathlib import Path
import zipfile
import json

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "extension" / "manifest.json").read_text())["version"]
output = root / "dist" / f"supplier-viewer-{version}.zip"
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((root / "extension").rglob("*")):
        if file.is_file():
            archive.write(file, Path("supplier-viewer") / file.relative_to(root / "extension"))
    archive.write(root / "README.md", "supplier-viewer/README.md")
print(output)
