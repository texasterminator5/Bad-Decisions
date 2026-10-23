# NineSlot

Photograph a **9-pocket binder page** of baseball cards on your phone. NineSlot splits the page into nine slots, reads each card, matches the catalogue, and pulls guide market values.

## What it does

1. **Capture** — use the phone camera (or upload) aimed at a full binder sheet.
2. **Detect** — force a 3×3 pocket grid (OpenCV can tighten each slot).
3. **OCR** — Tesseract reads player, year, brand/set, and card number.
4. **Match** — MyCardfolio catalogue (`identify_card` / `search_cards`).
5. **Value** — SportsCardsPro guide prices (raw low / mid / gem high) plus deep links to eBay sold comps.

## Run locally

```bash
cd baseball-binder
npm install
pip install -r requirements.txt   # OpenCV for slot detection
npm start
```

Open [http://localhost:3851](http://localhost:3851) on your phone (same Wi‑Fi) or laptop.

> Tip: on iPhone, set Camera → Formats → **Most Compatible** so photos upload as JPEG.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/appraise` | multipart `image` (+ optional `grid=3x3`) → nine slot appraisals |
| `GET` | `/api/search?q=` | text search with prices |
| `POST` | `/api/resolve` | `{ query }` → match + price without a photo |
| `GET` | `/api/health` | liveness |

## Notes

- Guide prices are **not** formal appraisals. Condition, grading, and parallels matter.
- No API keys required for the default data sources.
- SportsCardsPro occasionally rate-limits; eBay sold links are always provided as a backup.
