"""Extrai ícones de um print de lista (6 linhas) e atualiza public/items/catalog.json."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

OUT = Path(r"E:\guildchapa\apps\web\public\items")
OUT.mkdir(parents=True, exist_ok=True)
CATALOG_PATH = OUT / "catalog.json"

# Uso: python extract-items.py <imagem> <slug|nome> ...
# Ex.: python extract-items.py print.png id1|Nome 1 id2|Nome 2 ...


def load_catalog() -> list[dict]:
  if not CATALOG_PATH.exists():
    return []
  data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
  return list(data.get("items") or [])


def save_catalog(items: list[dict]) -> None:
  by_id = {item["id"]: item for item in items}
  ordered = list(by_id.values())
  CATALOG_PATH.write_text(
    json.dumps({"items": ordered}, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
  )


def crop_icons(
  src: Path,
  entries: list[tuple[str, str]],
  skip_ids: set[str],
) -> list[dict]:
  im = Image.open(src).convert("RGBA")
  w, h = im.size
  rows = len(entries)
  row_h = h / rows
  pad_x = round(w * 0.02)
  pad_y = round(row_h * 0.12)
  icon = int(round(row_h - 2 * pad_y))

  added = []
  for i, (slug, name) in enumerate(entries):
    if slug in skip_ids:
      print("skip", slug, name)
      continue
    top = int(round(i * row_h + pad_y))
    left = pad_x
    box = (left, top, left + icon, top + icon)
    crop = im.crop(box).resize((128, 128), Image.Resampling.LANCZOS)
    filename = f"{slug}.png"
    crop.save(OUT / filename, optimize=True)
    item = {"id": slug, "name": name, "image": f"/items/{filename}"}
    added.append(item)
    print("saved", filename, name)
  return added


def main() -> None:
  if len(sys.argv) < 3:
    raise SystemExit("Uso: extract-items.py <imagem> slug|Nome ...")

  src = Path(sys.argv[1])
  entries = []
  for arg in sys.argv[2:]:
    if "|" not in arg:
      raise SystemExit(f"Entrada inválida (use slug|Nome): {arg}")
    slug, name = arg.split("|", 1)
    entries.append((slug.strip(), name.strip()))

  catalog = load_catalog()
  existing = {item["id"]: item for item in catalog}
  added = crop_icons(src, entries, set(existing))
  for item in added:
    existing[item["id"]] = item
  save_catalog(list(existing.values()))
  print("added", len(added), "total", len(existing))


if __name__ == "__main__":
  main()
