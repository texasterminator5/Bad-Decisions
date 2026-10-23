import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { appraiseCardBuffer } from "./lib/appraise.js";
import { detectCardCrops } from "./lib/detectCards.js";
import { resolveFromHints, searchCatalog } from "./lib/catalog.js";
import { enrichWithPrices } from "./lib/prices.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are supported"));
      return;
    }
    cb(null, true);
  },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "nineslot" });
});

/**
 * Manual text search — useful when OCR misses.
 */
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || req.query.name || "").trim();
    const year = String(req.query.year || "").trim() || null;
    if (!q) {
      res.status(400).json({ error: "Provide ?q=player+set+number" });
      return;
    }
    const cards = await searchCatalog({ query: q, year, limit: 16 });
    const priced = [];
    for (const card of cards.slice(0, 8)) {
      priced.push(await enrichWithPrices(card));
    }
    res.json({
      query: { q, year },
      cards: [...priced, ...cards.slice(8)],
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || "Search failed" });
  }
});

/**
 * Binder / multi-card photo → detect slots → OCR/match/price each.
 * Query/body: grid=3x3 (default) | auto
 */
app.post("/api/appraise", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "Upload an image field named 'image'" });
      return;
    }

    const gridRaw = String(req.body?.grid || req.query.grid || "3x3").toLowerCase();
    // 3x3/binder = forced nine pockets; auto = detector chooses; 1 = whole frame
    let gridOpt = "3x3";
    if (gridRaw === "auto") gridOpt = "auto";
    else if (gridRaw === "1" || gridRaw === "single") gridOpt = "1";
    else gridOpt = "3x3";

    try {
      const debugDir = path.join(__dirname, "tmp");
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, "last-upload.jpg"), req.file.buffer);
    } catch (err) {
      console.warn("debug upload save failed:", err.message);
    }

    const crops = await detectCardCrops(req.file.buffer, { grid: gridOpt });

    const detections = [];
    for (const crop of crops) {
      try {
        const result = await appraiseCardBuffer(crop.buffer);
        detections.push({
          index: crop.index,
          slot: crop.slot,
          box: crop.box,
          previewDataUrl: `data:image/jpeg;base64,${crop.previewJpeg.toString("base64")}`,
          hints: result.hints,
          source: result.source,
          cards: result.cards,
          best: result.best,
          error: null,
        });
      } catch (err) {
        console.error(`crop ${crop.index} failed:`, err);
        detections.push({
          index: crop.index,
          slot: crop.slot,
          box: crop.box,
          previewDataUrl: `data:image/jpeg;base64,${crop.previewJpeg.toString("base64")}`,
          hints: null,
          source: null,
          cards: [],
          best: null,
          error: err.message || "Appraisal failed",
        });
      }
    }

    const valued = detections.filter((d) => d.best?.headline?.amount != null);
    const pageTotal = valued.reduce((sum, d) => sum + Number(d.best.headline.amount), 0);

    const payload = {
      detectionCount: detections.length,
      pageTotal: valued.length ? pageTotal : null,
      pageTotalCurrency: "USD",
      valuedCount: valued.length,
      detections,
    };

    try {
      const debugDir = path.join(__dirname, "tmp");
      await fs.writeFile(
        path.join(debugDir, "last-appraisal.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            detectionCount: detections.length,
            pageTotal: payload.pageTotal,
            detections: detections.map((d) => ({
              index: d.index,
              slot: d.slot,
              best: d.best && {
                id: d.best.id,
                name: d.best.name,
                year: d.best.year,
                product: d.best.product,
                number: d.best.number,
                headline: d.best.headline,
              },
              hints: d.hints && {
                players: d.hints.players,
                years: d.hints.years,
                brands: d.hints.brands,
                numbers: d.hints.numbers,
                query: d.hints.query,
              },
              error: d.error,
            })),
          },
          null,
          2
        )
      );
    } catch {
      // ignore
    }

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Appraisal failed" });
  }
});

/**
 * Re-resolve from a manual query string (no new photo).
 */
app.post("/api/resolve", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) {
      res.status(400).json({ error: "Provide { query }" });
      return;
    }
    const hints = {
      query,
      players: [],
      years: [],
      brands: [],
      numbers: [],
    };
    const { source, cards: raw } = await resolveFromHints(hints);
    const cards = [];
    for (const card of raw.slice(0, 6)) {
      cards.push(await enrichWithPrices(card));
    }
    res.json({ source, cards, best: cards[0] || null });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || "Resolve failed" });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Request failed" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.PORT) || 3851;
app.listen(PORT, () => {
  console.log(`NineSlot listening on http://localhost:${PORT}`);
});
