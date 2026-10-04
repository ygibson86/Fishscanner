"""
Printable A4 sheets with ArUco markers - the PDF side of the aquarium.

Ported from the standalone converter (tools/make_fish_pdf.py): take PNG/JPEG
drawings and produce one A4 landscape PDF page per drawing, with the four
DICT_4X4_50 markers near the corners (id 3 = top-left, 1 = top-right,
2 = bottom-right, 4 = bottom-left - the same ids app/scanner.py looks for)
and the drawing centered between them.

An empty image list yields a blank pattern sheet: print it, draw a fish
inside the frame, photograph it - the scanner will find the markers and cut
the background.

Usage:
    images = [prepare_image(raw) for raw in uploads]   # validates, raises ValueError
    pdf_bytes = build_pdf(images)                     # layout only
"""
import io
from typing import Dict, List, Optional

import cv2
import numpy as np
import pymupdf
from PIL import Image

# Page geometry in PDF points (1 pt = 1/72 inch): A4 LANDSCAPE = 842 x 595,
# so drawings sit the wide way and never look squashed after scanning.
PAGE_W, PAGE_H = 842, 595

# Marker squares (~83 pt each) near the corners of the landscape page.
MARKER_RECTS = {
    3: (60, 50, 143, 132),    # top-left
    1: (699, 50, 782, 132),   # top-right
    2: (699, 463, 782, 545),  # bottom-right
    4: (60, 463, 143, 545),   # bottom-left
}

# Wide central area available for the drawing.
FISH_BOX = (183, 152, 659, 443)

# The drawing area is ~476 pt wide: at 300 dpi that is ~1980 px, so anything
# larger only bloats the PDF without improving the print.
MAX_IMAGE_SIDE = 2000

_marker_cache: Dict[int, bytes] = {}


def _aruco_dictionary():
    # OpenCV renamed its aruco helpers in 4.7; the app pins 4.6 but this way
    # a future dependency bump does not silently break printing.
    if hasattr(cv2.aruco, "Dictionary_get"):
        return cv2.aruco.Dictionary_get(cv2.aruco.DICT_4X4_50)
    return cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)


def _marker_png(marker_id: int) -> bytes:
    """Render one ArUco marker with a white quiet zone as PNG bytes."""
    cached = _marker_cache.get(marker_id)
    if cached is not None:
        return cached

    dictionary = _aruco_dictionary()
    if hasattr(cv2.aruco, "generateImageMarker"):
        marker = cv2.aruco.generateImageMarker(dictionary, marker_id, 240)  # 6x6 cells
    else:
        marker = cv2.aruco.drawMarker(dictionary, marker_id, 240)

    canvas = np.full((320, 320), 255, dtype=np.uint8)
    canvas[40:280, 40:280] = marker
    ok, buf = cv2.imencode(".png", canvas)
    if not ok:
        raise RuntimeError("Не удалось отрисовать ArUco-метку")

    _marker_cache[marker_id] = buf.tobytes()
    return _marker_cache[marker_id]


def prepare_image(data: bytes) -> bytes:
    """
    Validate uploaded image bytes and shrink oversized ones so the PDF stays
    a reasonable size. Returns bytes safe to embed into the sheet.

    Raises ValueError when the data is not a readable image.
    """
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:
        raise ValueError("не удалось прочитать изображение") from exc

    if max(img.size) <= MAX_IMAGE_SIDE:
        # Small enough already: embed the original bytes untouched, keeping
        # whatever the author picked (transparency included).
        return data

    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    if img.mode in ("RGBA", "LA") or "transparency" in img.info:
        img.convert("RGBA").save(out, format="PNG")  # keeps transparency
    else:
        img.convert("RGB").save(out, format="JPEG", quality=90)
    return out.getvalue()


def _fit_rect(width: int, height: int) -> tuple:
    """Largest rect inside FISH_BOX keeping the image aspect ratio."""
    bx0, by0, bx1, by1 = FISH_BOX
    box_w, box_h = bx1 - bx0, by1 - by0
    scale = min(box_w / width, box_h / height)
    w, h = width * scale, height * scale
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


def build_pdf(images: Optional[List[bytes]] = None) -> bytes:
    """
    Build a PDF with one A4 landscape sheet per image and return its bytes.

    `images` must contain output of prepare_image(); pass an empty list (or
    None) for a blank pattern sheet with just the four markers.
    """
    doc = pymupdf.open()

    pages: List[Optional[bytes]] = list(images or [])
    if not pages:
        pages = [None]  # blank sheet

    for image_bytes in pages:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)

        for marker_id, rect in MARKER_RECTS.items():
            page.insert_image(pymupdf.Rect(*rect), stream=_marker_png(marker_id))

        if image_bytes is not None:
            with Image.open(io.BytesIO(image_bytes)) as img:
                width, height = img.size
            # insert_image keeps transparency; the page is white underneath.
            page.insert_image(pymupdf.Rect(*_fit_rect(width, height)), stream=image_bytes)

    # deflate_images: Flate-compress embedded bitmaps. Lossless, but without it
    # a batch of scanned drawings balloons to tens of MB (PyMuPDF stores image
    # samples uncompressed by default).
    pdf_bytes = doc.tobytes(deflate_images=True)
    doc.close()
    return pdf_bytes
