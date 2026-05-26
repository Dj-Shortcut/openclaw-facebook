from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def build_preview(source: Path, output: Path, label: str) -> None:
    image = Image.open(source).convert("RGB")

    target_width = 339
    image_area_height = 339
    canvas_height = 377
    label_area_height = canvas_height - image_area_height

    source_width, source_height = image.size
    crop_size = min(source_width, source_height)
    left = max(0, (source_width - crop_size) // 2)
    top = 0
    crop = image.crop((left, top, left + crop_size, top + crop_size))
    crop = crop.resize((target_width, image_area_height), Image.Resampling.LANCZOS)

    canvas = Image.new("RGB", (target_width, canvas_height), "white")
    canvas.paste(crop, (0, 0))

    draw = ImageDraw.Draw(canvas)
    try:
      font = ImageFont.truetype("arialbd.ttf", 30)
    except OSError:
      font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), label, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    text_x = (target_width - text_width) // 2
    text_y = image_area_height + ((label_area_height - text_height) // 2) - 2
    draw.text((text_x, text_y), label, fill="black", font=font)

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()

    build_preview(Path(args.source), Path(args.output), args.label)


if __name__ == "__main__":
    main()
