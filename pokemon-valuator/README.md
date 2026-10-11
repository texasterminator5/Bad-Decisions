# Valuedex

Snap a photo of a Pokémon Trading Card Game card and get live market prices.

## What it does

1. **Upload** a photo of one card or several laid out flat (or search by name).
2. **Detect** each card-shaped region in the frame.
3. **OCR** reads name, HP, collector number, attacks, and finish cues (e.g. stamped reverse).
4. **Match** against the Pokémon TCG catalogue (with TCGdex as fallback).
5. **Price** using TCGPlayer (USD) and Cardmarket (EUR), including reverse-holo variants.

## Run locally

```bash
cd pokemon-valuator
npm install
pip install -r requirements.txt   # OpenCV for multi-card detection
npm start
```

Open [http://localhost:3847](http://localhost:3847).

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/appraise` | multipart `image` → detect card(s), OCR, price each (`detections[]`) |
| `GET` | `/api/search?name=&number=` | text search with prices |
| `GET` | `/api/cards/:id` | single card by Pokémon TCG id (`base1-4`) |
| `GET` | `/api/health` | liveness |

## Notes

- Prices are marketplace guides, not appraisals. Condition, edition (1st/shadowless), language, and grading matter.
- No API keys are required for the default data sources.
- Optional: set `POKEMONTCG_API_KEY` in the environment later if you add higher rate limits via the Pokémon TCG developer portal.
