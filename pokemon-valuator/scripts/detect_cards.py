#!/usr/bin/env python3
"""Detect Pokémon-card-shaped rectangles in a photo. Prints JSON to stdout."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np


# Pokémon TCG card ratio is ~63mm x 88mm → width/height ≈ 0.716
TARGET_RATIO = 63 / 88
RATIO_TOL = 0.22


def order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def box_from_contour(cnt, img_w: int, img_h: int):
    peri = cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)
    if len(approx) == 4:
        pts = approx.reshape(4, 2).astype("float32")
        rect = order_points(pts)
        (tl, tr, br, bl) = rect
        width = max(
            float(np.linalg.norm(br - bl)),
            float(np.linalg.norm(tr - tl)),
        )
        height = max(
            float(np.linalg.norm(tr - br)),
            float(np.linalg.norm(tl - bl)),
        )
    else:
        x, y, w, h = cv2.boundingRect(cnt)
        if w < 8 or h < 8:
            return None
        rect = np.array(
            [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype="float32"
        )
        width, height = float(w), float(h)

    if width <= 0 or height <= 0:
        return None

    # Normalize orientation so height is the long side
    if width > height:
        width, height = height, width

    ratio = width / height
    if abs(ratio - TARGET_RATIO) > RATIO_TOL:
        return None

    area = width * height
    frame_area = float(img_w * img_h)
    if area < frame_area * 0.02 or area > frame_area * 0.96:
        return None

    xs = rect[:, 0]
    ys = rect[:, 1]
    x0 = max(0, int(np.floor(xs.min())))
    y0 = max(0, int(np.floor(ys.min())))
    x1 = min(img_w, int(np.ceil(xs.max())))
    y1 = min(img_h, int(np.ceil(ys.max())))
    bw, bh = x1 - x0, y1 - y0
    if bw < 40 or bh < 40:
        return None

    return {
        "x": x0,
        "y": y0,
        "width": bw,
        "height": bh,
        "area": int(area),
        "ratio": round(ratio, 3),
        "quad": [[float(px), float(py)] for px, py in rect.tolist()],
    }


def find_cards(image_path: str) -> list[dict]:
    original = cv2.imread(image_path)
    if original is None:
        raise SystemExit(f"Could not read image: {image_path}")

    img_h, img_w = original.shape[:2]
    scale = 1000 / max(img_w, img_h)
    if scale < 1:
        work = cv2.resize(original, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        work = original.copy()
        scale = 1.0

    wh, ww = work.shape[:2]
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    candidates: list[dict] = []

    # Strategy A: edges + contours
    edges = cv2.Canny(gray, 40, 140)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in cnts:
        box = box_from_contour(cnt, ww, wh)
        if box:
            candidates.append(box)

    # Strategy B: adaptive threshold blobs (helps on busy table backgrounds)
    thr = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 5
    )
    thr = cv2.bitwise_not(thr)
    thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
    cnts, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in cnts:
        box = box_from_contour(cnt, ww, wh)
        if box:
            candidates.append(box)

    # Scale boxes back to original coordinates
    if scale != 1.0:
        inv = 1.0 / scale
        for box in candidates:
            box["x"] = int(round(box["x"] * inv))
            box["y"] = int(round(box["y"] * inv))
            box["width"] = int(round(box["width"] * inv))
            box["height"] = int(round(box["height"] * inv))
            box["area"] = int(box["width"] * box["height"])
            box["quad"] = [[p[0] * inv, p[1] * inv] for p in box["quad"]]

    # Non-maximum suppression by IoU
    candidates.sort(key=lambda b: b["area"], reverse=True)
    kept: list[dict] = []

    def iou(a, b):
        ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
        bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
        ix1, iy1 = max(a["x"], b["x"]), max(a["y"], b["y"])
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
        inter = iw * ih
        if inter <= 0:
            return 0.0
        union = a["area"] + b["area"] - inter
        return inter / union if union else 0.0

    for box in candidates:
        if any(iou(box, k) > 0.35 for k in kept):
            continue
        kept.append(box)

    # Sort reading-order: top-to-bottom, then left-to-right
    kept.sort(key=lambda b: (b["y"] // max(1, img_h // 8), b["x"]))

    # Cap to a sane number for mobile photos
    return kept[:12]


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: detect_cards.py <image>", "cards": []}))
        raise SystemExit(2)
    path = sys.argv[1]
    if not Path(path).exists():
        print(json.dumps({"error": f"missing file {path}", "cards": []}))
        raise SystemExit(1)
    cards = find_cards(path)
    print(json.dumps({"cards": cards, "count": len(cards)}))


if __name__ == "__main__":
    main()
