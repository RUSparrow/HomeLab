#!/usr/bin/env python3
"""Картинка → Excel: каждая ячейка — квадратный «пиксель», залитый цветом.

    python make_pixel_art.py mona-lisa.jpg mona-lisa.xlsx --cols 160 --colors 256

Нужны pillow и openpyxl (pip install pillow openpyxl).

Как получается качество:
- картинка уменьшается до сетки фильтром Lanczos (каждая ячейка — среднее
  по своему участку, без «лесенки»);
- цвета сводятся к палитре (median cut + k-means): так картина остаётся
  живой, а в файле всего несколько сотен стилей — Excel медленнеет и ругается,
  когда их десятки тысяч;
- ширина столбца и высота строки подобраны так, чтобы ячейка была ровным
  квадратом в пикселях экрана (12 × 12 px при масштабе 100 %).
"""
import argparse
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from PIL import Image, ImageEnhance

CELL_PX = 12
# Excel хранит ширину столбца в «символах» шрифта по умолчанию (Calibri 11,
# цифра шириной 7 px) плюс 5 px полей: 12 px = (7 + 5) / 7 = 1,7109375.
COL_WIDTH = round((CELL_PX / 7) * 256) / 256
ROW_HEIGHT_PT = CELL_PX * 72 / 96      # 12 px при 96 dpi = 9 pt


def pixelate(path: Path, cols: int, colors: int) -> Image.Image:
    img = Image.open(path).convert("RGB")
    rows = round(cols * img.height / img.width)
    small = img.resize((cols, rows), Image.Resampling.LANCZOS)
    # После сильного уменьшения картина «тускнеет» — чуть возвращаем контраст и резкость
    small = ImageEnhance.Contrast(small).enhance(1.06)
    small = ImageEnhance.Sharpness(small).enhance(1.15)
    return small.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, kmeans=4,
                          dither=Image.Dither.NONE).convert("RGB")


def to_excel(img: Image.Image, out: Path, title: str, source: str) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]
    ws.sheet_view.showGridLines = False
    ws.sheet_view.showRowColHeaders = False
    # Масштаб, при котором картина целиком помещается на обычном экране
    ws.sheet_view.zoomScale = max(10, min(100, round(100 * 900 / (img.height * CELL_PX))))

    for c in range(1, img.width + 1):
        ws.column_dimensions[get_column_letter(c)].width = COL_WIDTH
    for r in range(1, img.height + 1):
        ws.row_dimensions[r].height = ROW_HEIGHT_PT

    fills: dict[tuple, PatternFill] = {}
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            rgb = px[x, y]
            fill = fills.get(rgb)
            if fill is None:
                hexrgb = "{:02X}{:02X}{:02X}".format(*rgb)
                fill = fills[rgb] = PatternFill("solid", start_color=hexrgb, end_color=hexrgb)
            ws.cell(row=y + 1, column=x + 1).fill = fill

    info = wb.create_sheet("О картине")
    info.column_dimensions["A"].width = 22
    info.column_dimensions["B"].width = 80
    rows = [
        ("Картина", title),
        ("Сетка", f"{img.width} × {img.height} ячеек ({img.width * img.height:,} шт.)".replace(",", " ")),
        ("Цветов", str(len(fills))),
        ("Ячейка", f"{CELL_PX} × {CELL_PX} px при масштабе 100 %"),
        ("Исходник", source),
        ("Как пересобрать", "python art/make_pixel_art.py <картинка> <файл.xlsx> --cols 160 --colors 256"),
    ]
    for i, (k, v) in enumerate(rows, start=1):
        info.cell(row=i, column=1, value=k).font = Font(bold=True)
        info.cell(row=i, column=2, value=v).alignment = Alignment(wrap_text=True)

    wb.save(out)
    print(f"{out}: {img.width}×{img.height} ячеек, {len(fills)} цветов")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--cols", type=int, default=160, help="ширина картины в ячейках")
    ap.add_argument("--colors", type=int, default=256, help="размер палитры")
    ap.add_argument("--title", default="Мона Лиза")
    ap.add_argument("--source", default="")
    ap.add_argument("--preview", type=Path, help="сохранить PNG того, что получится в Excel")
    a = ap.parse_args()

    img = pixelate(a.image, a.cols, a.colors)
    if a.preview:
        img.resize((img.width * 4, img.height * 4), Image.Resampling.NEAREST).save(a.preview)
    to_excel(img, a.out, a.title, a.source)


if __name__ == "__main__":
    main()
