import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "detect_cards.py");

function runDetect(imagePath, { grid } = {}) {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT, imagePath];
    if (grid) args.push("--grid", String(grid));
    const child = spawn("python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `detect_cards exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Bad detector JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Find card-shaped regions (default: binder 3x3) and return cropped buffers.
 * grid: "3x3" | "auto" | "1"
 */
export async function detectCardCrops(buffer, { grid = "3x3" } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nineslot-"));
  const inputPath = path.join(tmpDir, "input.jpg");

  try {
    const normalized = await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
    await fs.writeFile(inputPath, normalized);

    const meta = await sharp(normalized).metadata();
    const imgW = meta.width || 1;
    const imgH = meta.height || 1;

    if (grid === "1" || grid === "single") {
      const previewJpeg = await sharp(normalized)
        .resize({ width: 280, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      return [
        {
          index: 0,
          slot: 0,
          box: { x: 0, y: 0, width: imgW, height: imgH },
          buffer: normalized,
          previewJpeg,
        },
      ];
    }

    let detections = [];
    try {
      const detectGrid = grid === "auto" ? null : "3x3";
      const result = await runDetect(inputPath, { grid: detectGrid });
      detections = result.cards || [];
    } catch (err) {
      console.warn("card detection failed:", err.message);
      detections = [];
    }

    if (!detections.length) {
      return [
        {
          index: 0,
          slot: 0,
          box: { x: 0, y: 0, width: imgW, height: imgH },
          buffer: normalized,
          previewJpeg: normalized,
        },
      ];
    }

    const crops = [];
    for (let i = 0; i < detections.length; i++) {
      const box = detections[i];
      const padX = Math.round(box.width * 0.02);
      const padY = Math.round(box.height * 0.02);
      let left = Math.max(0, Math.floor(box.x - padX));
      let top = Math.max(0, Math.floor(box.y - padY));
      let width = Math.floor(box.width + padX * 2);
      let height = Math.floor(box.height + padY * 2);
      if (left + width > imgW) width = imgW - left;
      if (top + height > imgH) height = imgH - top;
      if (width < 20 || height < 20) continue;

      const crop = await sharp(normalized)
        .extract({ left, top, width, height })
        .jpeg({ quality: 92 })
        .toBuffer();

      const previewJpeg = await sharp(crop)
        .resize({ width: 280, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();

      crops.push({
        index: crops.length,
        slot: box.slot ?? i,
        box: { x: left, y: top, width, height },
        buffer: crop,
        previewJpeg,
      });
    }

    if (!crops.length) {
      return [
        {
          index: 0,
          slot: 0,
          box: { x: 0, y: 0, width: imgW, height: imgH },
          buffer: normalized,
          previewJpeg: normalized,
        },
      ];
    }

    return crops;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
