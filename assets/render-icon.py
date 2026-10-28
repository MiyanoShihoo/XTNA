"""Render the XTNA mark to PNG at release sizes.

Geometry mirrors assets/icon.svg exactly so the two never drift.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BG = (11, 14, 20, 255)
GRID = (26, 35, 49, 56)
HEX = (46, 59, 87, 255)
AMBER_TOP = (255, 194, 74)
AMBER_BOTTOM = (255, 122, 24)
PAD = (255, 211, 122, 255)
CURSOR = (61, 255, 158, 255)
CURSOR_DIM = (23, 61, 44, 255)


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def trace_color(t: float) -> tuple[int, int, int, int]:
    return (
        lerp(AMBER_TOP[0], AMBER_BOTTOM[0], t),
        lerp(AMBER_TOP[1], AMBER_BOTTOM[1], t),
        lerp(AMBER_TOP[2], AMBER_BOTTOM[2], t),
        255,
    )


def thick_line(draw: ImageDraw.ImageDraw, start, end, width: int) -> None:
    """Draw a line with per-segment gradient and round caps."""
    x0, y0 = start
    x1, y1 = end
    steps = max(2, int(math.hypot(x1 - x0, y1 - y0) / 2))
    r = width // 2
    for i in range(steps):
        t0 = i / steps
        t1 = (i + 1) / steps
        ax, ay = x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0
        bx, by = x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1
        draw.line((ax, ay, bx, by), fill=trace_color(t0), width=width)
    for cx, cy in (start, end):
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=trace_color(0 if start == (x0, y0) else 1))


def render(size: int, out: Path) -> None:
    scale = size / 512
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(112 * scale), fill=BG)

    grid_start, grid_end = int(64 * scale), int(448 * scale)
    for pos in (128, 256, 384):
        p = pos * scale
        draw.line((p, grid_start, p, grid_end), fill=GRID, width=max(1, int(2 * scale)))
        draw.line((grid_start, p, grid_end, p), fill=GRID, width=max(1, int(2 * scale)))

    hexagon = [
        (256, 64),
        (418, 158),
        (418, 346),
        (256, 440),
        (94, 346),
        (94, 158),
    ]
    draw.line(
        [tuple((x * scale, y * scale)) for x, y in hexagon + [hexagon[0]]],
        fill=HEX,
        width=max(2, int(7 * scale)),
        joint="curve",
    )

    width = int(56 * scale)
    thick_line(draw, (172 * scale, 172 * scale), (340 * scale, 340 * scale), width)
    thick_line(draw, (340 * scale, 172 * scale), (172 * scale, 340 * scale), width)

    r = int(14 * scale)
    for cx, cy in ((172, 172), (340, 172), (172, 340), (340, 340)):
        draw.ellipse(
            (cx * scale - r, cy * scale - r, cx * scale + r, cy * scale + r), fill=PAD
        )

    image.save(out, "PNG", optimize=True)
    print(f"{out.name}: {size}x{size}")


def hex_rgb(value: str) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), 255)


def main() -> int:
    args = sys.argv[1:]
    root = Path(args[0]) if args else Path("assets")
    prefix = "icon"
    global AMBER_TOP, AMBER_BOTTOM, PAD, BG
    rest = args[1:]
    for i in range(0, len(rest) - 1, 2):
        flag, value = rest[i], rest[i + 1]
        if flag == "--prefix":
            prefix = value
        elif flag == "--top":
            AMBER_TOP = hex_rgb(value)
        elif flag == "--bottom":
            AMBER_BOTTOM = hex_rgb(value)
        elif flag == "--pad":
            PAD = hex_rgb(value)
        elif flag == "--bg":
            BG = hex_rgb(value)
    root.mkdir(parents=True, exist_ok=True)
    for size in (512, 256, 128, 64, 32):
        render(size, root / f"{prefix}-{size}.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
