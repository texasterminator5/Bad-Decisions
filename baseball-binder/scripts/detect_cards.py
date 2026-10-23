#!/usr/bin/env python3
"""Detect baseball-card rectangles in a binder-page photo. Prints JSON to stdout.

Prefers a 3x3 pocket layout when the frame looks like a binder page.
Also accepts --grid 3x3 to force nine equal slots.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# Standard trading card ≈ 2.5" x 3.5" → width/height ≈ 0.714
TARGET_RATIO = 2.5 / 3.5
RATIO_TOL = 0.32


def order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def box_from_contour(cnt, img_w: int, img_h: int, *, max_area_frac: float = 0.22):
    area_px = float(cv2.contourArea(cnt))
    frame_area = float(img_w * img_h)
    # Binder pages: each pocket is ~1/9 of the page; allow some slack
    if area_px < frame_area * 0.012:
        return None

    rect = cv2.minAreaRect(cnt)
    (cx, cy), (rw, rh), _angle = rect
    if rw <= 1 or rh <= 1:
        return None

    width, height = float(min(rw, rh)), float(max(rw, rh))
    ratio = width / height
    if abs(ratio - TARGET_RATIO) > RATIO_TOL:
        if not (0.52 <= ratio <= 0.98):
            return None

    box_area = width * height
    if box_area < frame_area * 0.015 or box_area > frame_area * max_area_frac:
        return None

    x, y, bw, bh = cv2.boundingRect(cnt)
    if bw < 40 or bh < 50:
        return None
    aa_ratio = min(bw, bh) / max(bw, bh)
    if aa_ratio < 0.48:
        return None

    box_pts = cv2.boxPoints(rect).astype("float32")
    ordered = order_points(box_pts)

    return {
        "x": int(max(0, x)),
        "y": int(max(0, y)),
        "width": int(min(img_w - x, bw)),
        "height": int(min(img_h - y, bh)),
        "area": int(box_area),
        "ratio": round(ratio, 3),
        "quad": [[float(px), float(py)] for px, py in ordered.tolist()],
        "center": [float(cx), float(cy)],
    }


def collect_candidates(work, max_area_frac: float = 0.22) -> list[dict]:
    wh, ww = work.shape[:2]
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    candidates: list[dict] = []

    for t1, t2, dilate_iters in (
        (20, 80, 2),
        (35, 120, 2),
        (50, 160, 1),
        (12, 50, 3),
    ):
        edges = cv2.Canny(gray, t1, t2)
        kernel = np.ones((3, 3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=dilate_iters)
        cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in cnts:
            box = box_from_contour(cnt, ww, wh, max_area_frac=max_area_frac)
            if box:
                candidates.append(box)

    for blur_k in (5, 9):
        g = cv2.GaussianBlur(gray, (blur_k, blur_k), 0)
        _, thr = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if np.mean(thr) > 127:
            thr = cv2.bitwise_not(thr)
        thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
        thr = cv2.morphologyEx(thr, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8), iterations=1)
        cnts, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in cnts:
            box = box_from_contour(cnt, ww, wh, max_area_frac=max_area_frac)
            if box:
                candidates.append(box)

    return candidates


def nms(candidates: list[dict], iou_thresh: float = 0.35) -> list[dict]:
    candidates = sorted(candidates, key=lambda b: b["area"], reverse=True)
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
        if any(iou(box, k) > iou_thresh for k in kept):
            continue
        kept.append(box)
    return kept


def scale_boxes(boxes: list[dict], inv: float) -> list[dict]:
    if inv == 1.0:
        return boxes
    out = []
    for box in boxes:
        b = dict(box)
        b["x"] = int(round(box["x"] * inv))
        b["y"] = int(round(box["y"] * inv))
        b["width"] = int(round(box["width"] * inv))
        b["height"] = int(round(box["height"] * inv))
        b["area"] = int(b["width"] * b["height"])
        b["quad"] = [[p[0] * inv, p[1] * inv] for p in box["quad"]]
        if "center" in box:
            b["center"] = [box["center"][0] * inv, box["center"][1] * inv]
        out.append(b)
    return out


def make_grid(img_w: int, img_h: int, cols: int = 3, rows: int = 3, margin: float = 0.02) -> list[dict]:
    """Equal 3x3 pocket slots covering the page (reading order)."""
    mx = int(img_w * margin)
    my = int(img_h * margin)
    inner_w = img_w - 2 * mx
    inner_h = img_h - 2 * my
    gap_x = int(inner_w * 0.02)
    gap_y = int(inner_h * 0.02)
    cell_w = (inner_w - gap_x * (cols - 1)) // cols
    cell_h = (inner_h - gap_y * (rows - 1)) // rows
    boxes = []
    for r in range(rows):
        for c in range(cols):
            x = mx + c * (cell_w + gap_x)
            y = my + r * (cell_h + gap_y)
            boxes.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "width": int(cell_w),
                    "height": int(cell_h),
                    "area": int(cell_w * cell_h),
                    "ratio": round(min(cell_w, cell_h) / max(cell_w, cell_h), 3),
                    "quad": [],
                    "fallback": f"grid-{r}-{c}",
                    "slot": r * cols + c,
                }
            )
    return boxes


def sort_reading_order(boxes: list[dict], img_h: int) -> list[dict]:
    row_h = max(1, img_h // 12)
    return sorted(boxes, key=lambda b: (b["y"] // row_h, b["x"]))


def refine_grid_cells(original, grid_boxes: list[dict]) -> list[dict]:
    """Tighten each grid cell around the brightest card-like region inside it."""
    refined = []
    for box in grid_boxes:
        crop = original[
            box["y"] : box["y"] + box["height"],
            box["x"] : box["x"] + box["width"],
        ]
        if crop.size == 0:
            refined.append(box)
            continue
        local = collect_candidates(crop, max_area_frac=0.95)
        local = nms(local)
        if not local:
            refined.append(box)
            continue
        best = max(local, key=lambda b: b["area"])
        # Only accept if it fills a meaningful portion of the pocket
        if best["area"] < box["area"] * 0.25:
            refined.append(box)
            continue
        refined.append(
            {
                "x": box["x"] + best["x"],
                "y": box["y"] + best["y"],
                "width": best["width"],
                "height": best["height"],
                "area": best["area"],
                "ratio": best["ratio"],
                "quad": [[p[0] + box["x"], p[1] + box["y"]] for p in best["quad"]],
                "fallback": box.get("fallback"),
                "slot": box.get("slot"),
            }
        )
    return refined


def find_cards(image_path: str, force_grid: str | None = None) -> list[dict]:
    original = cv2.imread(image_path)
    if original is None:
        raise SystemExit(f"Could not read image: {image_path}")

    img_h, img_w = original.shape[:2]

    if force_grid in ("3x3", "9", "binder"):
        grid = make_grid(img_w, img_h, 3, 3)
        return refine_grid_cells(original, grid)

    scale = 1400 / max(img_w, img_h)
    if scale < 1:
        work = cv2.resize(original, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        work = original.copy()
        scale = 1.0

    candidates = collect_candidates(work, max_area_frac=0.22)
    kept = nms(candidates)
    kept = scale_boxes(kept, 1.0 / scale if scale != 1.0 else 1.0)

    if len(kept) >= 4:
        areas = np.array([b["area"] for b in kept], dtype=float)
        median = float(np.median(areas[:9]))
        similar = [b for b in kept if 0.4 * median <= b["area"] <= 2.4 * median]
        if len(similar) >= 4:
            kept = similar

    frame_area = float(img_w * img_h)
    kept = [b for b in kept if b["area"] <= frame_area * 0.28]

    # Binder page heuristic: many similar pockets → pad to 3x3 grid
    if 6 <= len(kept) <= 12:
        kept = sort_reading_order(kept, img_h)[:9]
        return kept

    if len(kept) >= 9:
        return sort_reading_order(kept, img_h)[:9]

    # Fall back to forced 3x3 for portrait binder-like frames
    aspect = img_h / max(1, img_w)
    if aspect >= 1.05 or len(kept) < 2:
        grid = make_grid(img_w, img_h, 3, 3)
        return refine_grid_cells(original, grid)

    return sort_reading_order(kept, img_h)[:9]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument(
        "--grid",
        default=None,
        help="Force layout: 3x3 / binder / 9",
    )
    args = parser.parse_args()
    path = args.image
    if not Path(path).exists():
        print(json.dumps({"error": f"missing file {path}", "cards": []}))
        raise SystemExit(1)
    cards = find_cards(path, force_grid=args.grid)
    print(json.dumps({"cards": cards, "count": len(cards), "mode": args.grid or "auto"}))


if __name__ == "__main__":
    main()
