from PIL import Image, ImageDraw, ImageFont
import numpy as np
from pathlib import Path

SRC = Path(r"C:\Users\nenem\.cursor\projects\e-guildchapa\assets\c__Users_nenem_AppData_Roaming_Cursor_User_workspaceStorage_ad667904c9b5b1af2a65bcc8d5f7042a_images_mapa_geena-e239e706-9ad2-44a5-9ef7-b90ef25cb8a3.jpg")
OUT = Path(r"E:\guildchapa\apps\web\public\mapa-geena-posicionamento.png")
# also keep a clean copy near assets for sharing
OUT2 = Path(r"E:\guildchapa\mapa-geena-posicionamento.png")

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im)
h, w, _ = arr.shape
r = arr[:, :, 0].astype(int)
g = arr[:, :, 1].astype(int)
b = arr[:, :, 2].astype(int)

red_m = (r > 180) & (g < 100) & (b < 100)
green_m = (g > 140) & (r < 120) & (b < 120)
yellow_m = (r > 170) & (g > 150) & (b < 100)


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
    # merge nearby duplicates
    pts.sort(key=lambda p: -p[2])
    kept = []
    for x, y, n in pts:
        if any((x - kx) ** 2 + (y - ky) ** 2 < 18 ** 2 for kx, ky, _ in kept):
            continue
        kept.append((x, y, n))
    return [(x, y) for x, y, _ in kept]


reds = centroids(red_m)
greens = centroids(green_m)
yellows = centroids(yellow_m)
print("red", reds)
print("green", greens)
print("yellow", yellows)

# Cover old hand-drawn dots with nearby map color, then redraw clean markers
work = im.copy()
draw = ImageDraw.Draw(work)


def cover(points, radius=14):
    for x, y in points:
        # sample ring around blob for background fill
        samples = []
        for a in range(0, 360, 30):
            rad = np.deg2rad(a)
            sx = int(x + np.cos(rad) * (radius + 8))
            sy = int(y + np.sin(rad) * (radius + 8))
            if 0 <= sx < w and 0 <= sy < h:
                samples.append(im.getpixel((sx, sy)))
        if not samples:
            continue
        # median-ish average
        fill = tuple(int(sum(c[i] for c in samples) / len(samples)) for i in range(3))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


cover(reds + greens + yellows, radius=16)

# redraw clean markers
COLORS = {
    "red": ((220, 38, 38), (255, 255, 255)),
    "green": ((22, 163, 74), (255, 255, 255)),
    "yellow": ((234, 179, 8), (20, 20, 20)),
}


def marker(x, y, color_key, label=None):
    fill, ink = COLORS[color_key]
    r0 = 11
    draw.ellipse((x - r0 - 2, y - r0 - 2, x + r0 + 2, y + r0 + 2), fill=(0, 0, 0))
    draw.ellipse((x - r0, y - r0, x + r0, y + r0), fill=fill, outline=ink, width=2)


for x, y in reds:
    marker(x, y, "red")
for x, y in greens:
    marker(x, y, "green")
for x, y in yellows:
    marker(x, y, "yellow")

# legend panel
panel_w, panel_h = 320, 118
px, py = 18, h - panel_h - 18
draw.rounded_rectangle((px, py, px + panel_w, py + panel_h), radius=12, fill=(18, 16, 16, 230) if False else (18, 16, 16), outline=(180, 40, 40), width=2)
try:
    font = ImageFont.truetype("arial.ttf", 16)
    font_sm = ImageFont.truetype("arial.ttf", 14)
    font_b = ImageFont.truetype("arialbd.ttf", 17)
except Exception:
    font = ImageFont.load_default()
    font_sm = font
    font_b = font

draw.text((px + 14, py + 10), "Geena — Posicionamento", fill=(255, 240, 240), font=font_b)

rows = [
    ("red", "Entrada 1"),
    ("green", "Entrada 2"),
    ("yellow", "Centro — players mais fortes"),
]
yy = py + 40
for key, text in rows:
    fill, ink = COLORS[key]
    draw.ellipse((px + 16, yy, px + 34, yy + 18), fill=fill, outline=ink, width=2)
    draw.text((px + 44, yy - 1), text, fill=(235, 235, 235), font=font_sm)
    yy += 24

OUT.parent.mkdir(parents=True, exist_ok=True)
work.save(OUT, "PNG")
work.save(OUT2, "PNG")
print("saved", OUT)
print("saved", OUT2)
