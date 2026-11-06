"""Encode Blender plates as browser assets and package camera anchors."""
import json
from pathlib import Path
import shutil
import sys

from PIL import Image


plates, assets = map(Path, sys.argv[-2:])
assets.mkdir(parents=True, exist_ok=True)
for phase in ("dawn", "day", "dusk", "cloud", "rain", "night", "wet-night", "snow", "snow-night"):
    for lamp in ("off", "on"):
        name = f"{phase}-{lamp}"
        for variant in (name, "plush-" + name):
            with Image.open(plates / f"{variant}.png") as image:
                mode = "RGBA" if variant.startswith("plush-") else "RGB"
                image.convert(mode).save(assets / f"{variant}.webp", quality=91, method=6)

with Image.open(plates / "portrait-sharp.png") as image:
    image.convert("RGB").save(assets / "photo-day.webp", quality=94, method=6)
for name in ("photo-ayou.webp", "plush.webp"):
    shutil.copyfile(plates / name, assets / name)

anchors = json.loads((plates / "anchors.json").read_text(encoding="utf-8"))
(assets / "anchors.js").write_text(
    "/* Camera anchors exported from Blender. */\nwindow.deskAnchors = "
    + json.dumps(anchors, separators=(",", ":")) + ";\n",
    encoding="utf-8",
)
