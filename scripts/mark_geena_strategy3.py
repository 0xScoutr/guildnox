from PIL import Image, ImageDraw, ImageFont
import numpy as np
from pathlib import Path

SRC = Path(r"C:\Users\nenem\.cursor\projects\e-guildchapa\assets\estrategi-d3310eec-abfd-4d2e-beee-7e859e0e664c.jpg")
OUT = Path(r"E:\guildchapa\mapa-geena-estrategia-atraso.png")
OUT2 = Path(r"E:\guildchapa\apps\web\public\mapa-geena-estrategia-atraso.png")

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im)
h, w, _ = arr.shape
r = arr[:, :, 0].astype(int)
g = arr[:, :, 1].astype(int)
b = arr[:, :, 2].astype(int)

red_m = (r > 165) & (g < 115) & (b < 115) & ((r - g) > 45) & ((r - b) > 45)
green_m = (g > 125) & (r < 135) & (b < 135) & ((g - r) > 20)


def centroids(mask, min_count=10):
    visited = np.zeros(mask.shape, dtype=bool)
    pts = []
    ys, xs = np.where(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if visited[y, x]:
            continue
        stack = [(y, x)]
        visited[y, x] = True
        cells = []
        while stack:
            cy, cx = stack.pop()
            cells.append((cy, cx))
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if len(cells) >= min_count:
            cy = sum(c[0] for c in cells) / len(cells)
            cx = sum(c[1] for c in cells) / len(cells)
            pts.append((int(round(cx)), int(round(cy)), len(cells)))
    pts.sort(key=lambda p: -p[2])
    kept = []
    for x, y, n in pts:
        if any((x - kx) ** 2 + (y - ky) ** 2 < 20 ** 2 for kx, ky, _ in kept):
            continue
        kept.append((x, y, n))
    return [(x, y) for x, y, _ in kept]


reds = centroids(red_m)
greens = centroids(green_m)
print("red", len(reds), reds)
print("green", len(greens), greens)

work = im.copy()
draw = ImageDraw.Draw(work)


def cover(points, radius=20):
    for x, y in points:
        samples = []
        for a in range(0, 360, 15):
            rad = np.deg2rad(a)
            for dist in (radius + 6, radius + 12, radius + 18, radius + 24):
                sx = int(x + np.cos(rad) * dist)
                sy = int(y + np.sin(rad) * dist)
                if 0 <= sx < w and 0 <= sy < h:
                    samples.append(im.getpixel((sx, sy)))
        if not samples:
            continue
        fill = tuple(int(sum(c[i] for c in samples) / len(samples)) for i in range(3))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


cover(reds + greens, radius=22)

COLORS = {
    "red": ((220, 38, 38), (255, 255, 255)),
    "green": ((22, 163, 74), (255, 255, 255)),
    "gold": ((234, 179, 8), (30, 20, 0)),
}


def marker(x, y, color_key, text=None):
    fill, ink = COLORS[color_key]
    r0 = 13
    draw.ellipse((x - r0 - 3, y - r0 - 3, x + r0 + 3, y + r0 + 3), fill=(0, 0, 0))
    draw.ellipse((x - r0, y - r0, x + r0, y + r0), fill=fill, outline=ink, width=2)
    if text:
        try:
            font = ImageFont.truetype("arialbd.ttf", 12)
        except Exception:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text((x - tw / 2, y - th / 2 - 1), text, fill=ink, font=font)


for x, y in greens:
    marker(x, y, "green", "5")
for x, y in reds:
    marker(x, y, "red", "2")

# Card flutuante compacto no canto, longe das marcações de atraso.
try:
    font_b = ImageFont.truetype("arialbd.ttf", 13)
    font_sm = ImageFont.truetype("arial.ttf", 11)
except Exception:
    font_b = ImageFont.load_default()
    font_sm = font_b

panel_w, panel_h = 200, 72
# Centro (Fonte): sem pontos de atraso
px = (w - panel_w) // 2
py = (h - panel_h) // 2 - 8
draw.rounded_rectangle(
    (px, py, px + panel_w, py + panel_h),
    radius=8,
    fill=(18, 16, 16),
    outline=(180, 40, 40),
    width=1,
)

draw.text((px + 8, py + 6), "Geena — Atraso", fill=(255, 240, 240), font=font_b)

rows = [
    ("green", "Verde — 5 atrasando"),
    ("red", "Vermelho — 2 atrasando"),
    ("gold", "Bosses — fortes"),
]
yy = py + 26
for key, text in rows:
    fill, ink = COLORS[key]
    draw.ellipse((px + 10, yy + 2, px + 20, yy + 12), fill=fill, outline=ink, width=1)
    draw.text((px + 26, yy - 1), text, fill=(235, 235, 235), font=font_sm)
    yy += 14


OUT.parent.mkdir(parents=True, exist_ok=True)
OUT2.parent.mkdir(parents=True, exist_ok=True)
work.save(OUT, "PNG")
work.save(OUT2, "PNG")
print("saved", OUT)
print("saved", OUT2)
