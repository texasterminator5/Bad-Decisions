# Valuedex

Snap a photo of a Pokémon Trading Card Game card and get live market prices.

## What it does

1. **Upload** a card photo (or search by name).
2. **OCR** reads the card name, HP, and collector number (`025/165`, etc.).
3. **Match** against the Pokémon TCG catalogue (with TCGdex as fallback).
4. **Price** using TCGPlayer (USD) and Cardmarket (EUR) market feeds.

## Run locally

```bash
cd pokemon-valuator
npm install
npm start
```

Open [http://localhost:3847](http://localhost:3847).

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/appraise` | multipart field `image` → OCR + ranked priced matches |
| `GET` | `/api/search?name=&number=` | text search with prices |
| `GET` | `/api/cards/:id` | single card by Pokémon TCG id (`base1-4`) |
| `GET` | `/api/health` | liveness |

## Notes

- Prices are marketplace guides, not appraisals. Condition, edition (1st/shadowless), language, and grading matter.
- No API keys are required for the default data sources.
- Optional: set `POKEMONTCG_API_KEY` in the environment later if you add higher rate limits via the Pokémon TCG developer portal.
