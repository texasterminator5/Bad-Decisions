import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { identifyFromImage } from "./lib/ocr.js";
import { rankByVisualSimilarity } from "./lib/imageMatch.js";
import { getPokemonTcgCard, resolveCards } from "./lib/prices.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
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
  res.json({ ok: true, service: "valuedex" });
});

/**
 * Manual text search — useful when OCR misses or you already know the card.
 */
app.get("/api/search", async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    const number = String(req.query.number || "").trim() || null;
    if (!name) {
      res.status(400).json({ error: "Provide a card name (?name=...)" });
      return;
    }
    const { source, cards } = await resolveCards({
      names: [name],
      numbers: number
        ? [{ localId: number, localIdRaw: number, raw: number }]
        : [],
      name,
      number,
    });
    res.json({ query: { name, number }, source, cards });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || "Search failed" });
  }
});

/**
 * Photo → OCR hints → ranked cards with live market prices.
 */
app.post("/api/appraise", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "Upload an image field named 'image'" });
      return;
    }

    // Keep the latest upload for debugging wrong-print matches
    try {
      const debugDir = path.join(__dirname, "tmp");
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, "last-upload.jpg"), req.file.buffer);
    } catch (err) {
      console.warn("debug upload save failed:", err.message);
    }

    const hints = await identifyFromImage(req.file.buffer);
    const { source, cards: rawCards } = await resolveCards(hints);

    // When the collector number is missing/weak, many prints share a name.
    // Re-rank by visual similarity to the official scans.
    const cards = await rankByVisualSimilarity(req.file.buffer, rawCards, {
      limit: Math.min(16, rawCards.length || 0),
    });

    const payload = {
      hints,
      source,
      cards,
      best: cards[0] || null,
    };

    try {
      const debugDir = path.join(__dirname, "tmp");
      await fs.writeFile(
        path.join(debugDir, "last-appraisal.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            hints,
            source,
            best: payload.best && {
              id: payload.best.id,
              name: payload.best.name,
              number: payload.best.number,
              set: payload.best.set?.name,
              matchScore: payload.best.matchScore,
              visualScore: payload.best.visualScore,
              visualDistance: payload.best.visualDistance,
              headline: payload.best.headline,
            },
            top: cards.slice(0, 8).map((c) => ({
              id: c.id,
              name: c.name,
              number: c.number,
              set: c.set?.name,
              matchScore: c.matchScore,
              visualScore: c.visualScore,
              visualDistance: c.visualDistance,
            })),
          },
          null,
          2
        )
      );
    } catch {
      // ignore debug write errors
    }

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Appraisal failed" });
  }
});

/**
 * Direct card fetch by Pokémon TCG id (e.g. base1-4).
 */
app.get("/api/cards/:id", async (req, res) => {
  try {
    const card = await getPokemonTcgCard(req.params.id);
    res.json({ card });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || "Lookup failed" });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Request failed" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.PORT) || 3847;
app.listen(PORT, () => {
  console.log(`Valuedex listening on http://localhost:${PORT}`);
});
