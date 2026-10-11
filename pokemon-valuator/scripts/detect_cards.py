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
RATIO_TOL = 0.28


def order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def box_from_contour(cnt, img_w: int, img_h: int, *, max_area_frac: float = 0.55):
    area_px = float(cv2.contourArea(cnt))
    frame_area = float(img_w * img_h)
    if area_px < frame_area * 0.03:
        return None

    rect = cv2.minAreaRect(cnt)
    (cx, cy), (rw, rh), _angle = rect
    if rw <= 1 or rh <= 1:
        return None

    width, height = float(min(rw, rh)), float(max(rw, rh))
    ratio = width / height
    if abs(ratio - TARGET_RATIO) > RATIO_TOL:
        # Also accept top-loader outer shells which are slightly squarer/taller
        if not (0.55 <= ratio <= 0.95):
            return None

    box_area = width * height
    if box_area < frame_area * 0.04 or box_area > frame_area * max_area_frac:
        return None

    # Aspect of axis-aligned bounding box should also be card-like-ish
    x, y, bw, bh = cv2.boundingRect(cnt)
    if bw < 60 or bh < 60:
        return None
    aa_ratio = min(bw, bh) / max(bw, bh)
    if aa_ratio < 0.55:
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


def collect_candidates(work, max_area_frac: float = 0.55) -> list[dict]:
    wh, ww = work.shape[:2]
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    candidates: list[dict] = []

    # Multiple edge sensitivities — top loaders + glare need softer and harder passes
    for t1, t2, dilate_iters in (
        (25, 90, 2),
        (40, 140, 2),
        (60, 180, 1),
        (15, 60, 3),
    ):
        edges = cv2.Canny(gray, t1, t2)
        kernel = np.ones((3, 3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=dilate_iters)
        # RETR_LIST: sleeved cards often sit inside a larger outer contour
        cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in cnts:
            box = box_from_contour(cnt, ww, wh, max_area_frac=max_area_frac)
            if box:
                candidates.append(box)

    # Color/brightness threshold: cards are brighter than a dark table
    for blur_k in (5, 9):
        g = cv2.GaussianBlur(gray, (blur_k, blur_k), 0)
        _, thr = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Ensure cards are white: if most pixels are white, invert
        if np.mean(thr) > 127:
            thr = cv2.bitwise_not(thr)
        thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8), iterations=2)
        thr = cv2.morphologyEx(thr, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
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


def split_landscape_fallback(img_w: int, img_h: int) -> list[dict]:
    """When two cards sit side-by-side and contours merge, split the frame."""
    if img_w < img_h * 1.05:
        return []
    mid = img_w // 2
    gap = int(img_w * 0.02)
    left_w = mid - gap
    right_x = mid + gap
    right_w = img_w - right_x
    # Prefer portrait card crops within each half
    return [
        {
            "x": int(img_w * 0.03),
            "y": int(img_h * 0.05),
            "width": int(left_w - img_w * 0.03),
            "height": int(img_h * 0.9),
            "area": 0,
            "ratio": 0.7,
            "quad": [],
            "fallback": "left-half",
        },
        {
            "x": right_x,
            "y": int(img_h * 0.05),
            "width": int(right_w - img_w * 0.03),
            "height": int(img_h * 0.9),
            "area": 0,
            "ratio": 0.7,
            "quad": [],
            "fallback": "right-half",
        },
    ]


def find_cards(image_path: str) -> list[dict]:
    original = cv2.imread(image_path)
    if original is None:
        raise SystemExit(f"Could not read image: {image_path}")

    img_h, img_w = original.shape[:2]
    scale = 1200 / max(img_w, img_h)
    if scale < 1:
        work = cv2.resize(original, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        work = original.copy()
        scale = 1.0

    candidates = collect_candidates(work, max_area_frac=0.55)
    kept = nms(candidates)
    kept = scale_boxes(kept, 1.0 / scale if scale != 1.0 else 1.0)

    # Prefer a cluster of similarly sized card boxes (true multi-card spreads)
    if len(kept) >= 2:
        areas = np.array([b["area"] for b in kept], dtype=float)
        median = float(np.median(areas[:4]))
        similar = [
            b
            for b in kept
            if 0.45 * median <= b["area"] <= 2.2 * median
        ]
        if len(similar) >= 2:
            kept = similar

    # Reject a solitary near-full-frame false positive
    frame_area = float(img_w * img_h)
    kept = [b for b in kept if b["area"] <= frame_area * 0.6]

    if len(kept) < 2:
        # Contours merged (common with top loaders on a dark desk) — try halves
        halves = split_landscape_fallback(img_w, img_h)
        if halves:
            # Only use fallback if each half looks card-filled (bright content)
            usable = []
            for box in halves:
                crop = original[
                    box["y"] : box["y"] + box["height"],
                    box["x"] : box["x"] + box["width"],
                ]
                if crop.size == 0:
                    continue
                # Re-detect inside each half for a tighter crop
                local = collect_candidates(crop, max_area_frac=0.9)
                local = nms(local)
                if local:
                    best = max(local, key=lambda b: b["area"])
                    usable.append(
                        {
                            "x": box["x"] + best["x"],
                            "y": box["y"] + best["y"],
                            "width": best["width"],
                            "height": best["height"],
                            "area": best["area"],
                            "ratio": best["ratio"],
                            "quad": [
                                [p[0] + box["x"], p[1] + box["y"]] for p in best["quad"]
                            ],
                            "fallback": box.get("fallback"),
                        }
                    )
                else:
                    box["area"] = box["width"] * box["height"]
                    usable.append(box)
            if len(usable) >= 2:
                kept = usable

    kept.sort(key=lambda b: (b["y"] // max(1, img_h // 8), b["x"]))
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
