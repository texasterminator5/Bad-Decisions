import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { appraiseCardBuffer } from "./lib/appraise.js";
import { detectCardCrops } from "./lib/detectCards.js";
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
 * Photo → detect one or more cards → OCR/match/price each.
 */
app.post("/api/appraise", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "Upload an image field named 'image'" });
      return;
    }

    try {
      const debugDir = path.join(__dirname, "tmp");
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, "last-upload.jpg"), req.file.buffer);
    } catch (err) {
      console.warn("debug upload save failed:", err.message);
    }

    const crops = await detectCardCrops(req.file.buffer);

    // Appraise crops sequentially to avoid hammering upstream APIs / OCR CPU
    const detections = [];
    for (const crop of crops) {
      try {
        const result = await appraiseCardBuffer(crop.buffer);
        detections.push({
          index: crop.index,
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

    // Back-compat single-card fields (first detection)
    const primary = detections[0] || null;
    const payload = {
      detectionCount: detections.length,
      detections,
      // legacy single-card shape used by older clients
      hints: primary?.hints || null,
      source: primary?.source || null,
      cards: primary?.cards || [],
      best: primary?.best || null,
    };

    try {
      const debugDir = path.join(__dirname, "tmp");
      await fs.writeFile(
        path.join(debugDir, "last-appraisal.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            detectionCount: detections.length,
            detections: detections.map((d) => ({
              index: d.index,
              box: d.box,
              best: d.best && {
                id: d.best.id,
                name: d.best.name,
                number: d.best.number,
                set: d.best.set?.name,
                headline: d.best.headline,
                finishHints: d.best.finishHints,
              },
              hints: d.hints && {
                names: d.hints.names,
                numbers: d.hints.numbers,
                hp: d.hints.hp,
                attacks: d.hints.attacks,
                finish: d.hints.finish,
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
