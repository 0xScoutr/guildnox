from PIL import Image, ImageDraw, ImageFont
import numpy as np
from pathlib import Path

SRC = Path(r"C:\Users\nenem\.cursor\projects\e-guildchapa\assets\strategi-40f8a9cc-5968-452f-b21e-8ce1762710ec.jpg")
OUT = Path(r"E:\guildchapa\mapa-geena-estrategia-atraso.png")
OUT2 = Path(r"E:\guildchapa\apps\web\public\mapa-geena-estrategia-atraso.png")

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im)
h, w, _ = arr.shape
r = arr[:, :, 0].astype(int)
g = arr[:, :, 1].astype(int)
b = arr[:, :, 2].astype(int)

# Hand-drawn markers tend to be saturated
red_m = (r > 170) & (g < 110) & (b < 110) & ((r - g) > 50) & ((r - b) > 50)
green_m = (g > 130) & (r < 130) & (b < 130) & ((g - r) > 25)


def centroids(mask, min_count=12):
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
        if any((x - kx) ** 2 + (y - ky) ** 2 < 22 ** 2 for kx, ky, _ in kept):
            continue
        kept.append((x, y, n))
    return [(x, y) for x, y, _ in kept]


reds = centroids(red_m)
greens = centroids(green_m)
print("red", len(reds), reds)
print("green", len(greens), greens)

work = im.copy()
draw = ImageDraw.Draw(work)


def cover(points, radius=18):
    for x, y in points:
        samples = []
        for a in range(0, 360, 20):
            rad = np.deg2rad(a)
            for dist in (radius + 6, radius + 12, radius + 18):
                sx = int(x + np.cos(rad) * dist)
                sy = int(y + np.sin(rad) * dist)
                if 0 <= sx < w and 0 <= sy < h:
                    samples.append(im.getpixel((sx, sy)))
        if not samples:
            continue
        fill = tuple(int(sum(c[i] for c in samples) / len(samples)) for i in range(3))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


cover(reds + greens, radius=20)

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

# Boss clean note markers near major boss icons (approximate from layout)
# Optional subtle labels near outer bosses — skip coordinates if unsure; legend covers it.

panel_w, panel_h = 390, 148
px, py = 16, h - panel_h - 16
draw.rounded_rectangle(
    (px, py, px + panel_w, py + panel_h),
    radius=12,
    fill=(18, 16, 16),
    outline=(180, 40, 40),
    width=2,
)

try:
    font_b = ImageFont.truetype("arialbd.ttf", 17)
    font_sm = ImageFont.truetype("arial.ttf", 14)
except Exception:
    font_b = ImageFont.load_default()
    font_sm = font_b

draw.text((px + 14, py + 10), "Geena — Estratégia de atraso", fill=(255, 240, 240), font=font_b)

rows = [
    ("green", "Verde — 5 players atrasando a massa"),
    ("red", "Vermelho — 2 players atrasando a massa"),
    ("gold", "Bosses — players mais fortes limpando"),
]
yy = py + 42
for key, text in rows:
    fill, ink = COLORS[key]
    draw.ellipse((px + 16, yy, px + 34, yy + 18), fill=fill, outline=ink, width=2)
    draw.text((px + 44, yy - 1), text, fill=(235, 235, 235), font=font_sm)
    yy += 26

draw.text(
    (px + 14, py + panel_h - 22),
    f"{len(greens)} pontos verdes · {len(reds)} pontos vermelhos",
    fill=(170, 170, 170),
    font=font_sm,
)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT2.parent.mkdir(parents=True, exist_ok=True)
work.save(OUT, "PNG")
work.save(OUT2, "PNG")
print("saved", OUT)
print("saved", OUT2)
