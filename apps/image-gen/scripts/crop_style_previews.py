from __future__ import annotations

import json
from collections import deque
from pathlib import Path
from typing import Iterable

try:
    from PIL import Image
except ModuleNotFoundError as exc:
    raise SystemExit(
        "This script requires Pillow. Install it with: python -m pip install Pillow"
    ) from exc


SOURCE_IMAGE = Path("ChatGPT Image 18 mrt 2026, 21_33_54.png")
OUTPUT_DIR = Path("public/style-previews")

# The source collage contains 12 detected tiles in row-major order.
# We keep only the 10 tiles that map to the Leaderbot styles.
STYLE_TILE_INDEXES = {
    "caricature": 0,
    "storybook-anime": 1,
    "petals": 2,
    "gold": 3,
    "cinematic": 4,
    "oil-paint": 6,
    "cyberpunk": 8,
    "norman-blackwell": 9,
    "disco": 10,
    "clouds": 11,
}

WHITE_THRESHOLD = 245
MIN_COMPONENT_AREA = 50_000
PADDING = 6


def is_foreground(pixel: tuple[int, int, int]) -> bool:
    return any(channel < WHITE_THRESHOLD for channel in pixel)


def neighbors(x: int, y: int) -> Iterable[tuple[int, int]]:
    yield x + 1, y
    yield x - 1, y
    yield x, y + 1
    yield x, y - 1


def find_large_components(image: Image.Image) -> list[tuple[int, int, int, int]]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    visited = bytearray(width * height)
    boxes: list[tuple[int, int, int, int]] = []

    def index(x: int, y: int) -> int:
        return y * width + x

    for y in range(height):
        for x in range(width):
            idx = index(x, y)
            if visited[idx]:
                continue

            visited[idx] = 1
            if not is_foreground(pixels[x, y]):
                continue

            queue = deque([(x, y)])
            min_x = max_x = x
            min_y = max_y = y
            area = 0

            while queue:
                cx, cy = queue.popleft()
                area += 1
                min_x = min(min_x, cx)
                max_x = max(max_x, cx)
                min_y = min(min_y, cy)
                max_y = max(max_y, cy)

                for nx, ny in neighbors(cx, cy):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue

                    n_idx = index(nx, ny)
                    if visited[n_idx]:
                        continue

                    visited[n_idx] = 1
                    if is_foreground(pixels[nx, ny]):
                        queue.append((nx, ny))

            if area >= MIN_COMPONENT_AREA:
                boxes.append((min_x, min_y, max_x + 1, max_y + 1))

    return sorted(boxes, key=lambda box: (box[1], box[0]))


def expand_box(
    box: tuple[int, int, int, int], width: int, height: int
) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    return (
        max(0, left - PADDING),
        max(0, top - PADDING),
        min(width, right + PADDING),
        min(height, bottom + PADDING),
    )


def main() -> None:
    if not SOURCE_IMAGE.exists():
        raise SystemExit(f"Source image not found: {SOURCE_IMAGE}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    image = Image.open(SOURCE_IMAGE)
    boxes = find_large_components(image)

    if len(boxes) < max(STYLE_TILE_INDEXES.values()) + 1:
        raise SystemExit(
            f"Expected at least {max(STYLE_TILE_INDEXES.values()) + 1} large tiles, found {len(boxes)}"
        )

    manifest: dict[str, dict[str, object]] = {}

    for style, tile_index in STYLE_TILE_INDEXES.items():
        crop_box = expand_box(boxes[tile_index], image.width, image.height)
        cropped = image.crop(crop_box)
        output_path = OUTPUT_DIR / f"{style}.png"
        cropped.save(output_path)

        manifest[style] = {
            "tileIndex": tile_index,
            "cropBox": list(crop_box),
            "output": output_path.as_posix(),
        }

    manifest_path = OUTPUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote {len(STYLE_TILE_INDEXES)} style previews to {OUTPUT_DIR}")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
