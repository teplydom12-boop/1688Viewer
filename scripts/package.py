"""Build a load-unpacked archive without including dependencies or collected data."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
output = root / "dist" / "1688-viewer-0.1.0.zip"
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((root / "extension").rglob("*")):
        if file.is_file():
            archive.write(file, Path("1688-viewer") / file.relative_to(root / "extension"))
    archive.write(root / "README.md", "1688-viewer/README.md")
print(output)
