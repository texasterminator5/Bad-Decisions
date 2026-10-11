import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "detect_cards.py");

function runDetect(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SCRIPT, imagePath], {
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
      } catch (err) {
        reject(new Error(`Bad detector JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Find card-shaped regions in a photo and return cropped buffers.
 * Falls back to the full image when zero/one ambiguous detection.
 */
export async function detectCardCrops(buffer) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valuedex-"));
  const inputPath = path.join(tmpDir, "input.jpg");

  try {
    const normalized = await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
    await fs.writeFile(inputPath, normalized);

    const meta = await sharp(normalized).metadata();
    const imgW = meta.width || 1;
    const imgH = meta.height || 1;

    let detections = [];
    try {
      const result = await runDetect(inputPath);
      detections = result.cards || [];
    } catch (err) {
      console.warn("card detection failed:", err.message);
      detections = [];
    }

    // Single-card photos: if detector finds nothing, use the full frame
    if (!detections.length) {
      return [
        {
          index: 0,
          box: { x: 0, y: 0, width: imgW, height: imgH },
          buffer: normalized,
          previewJpeg: normalized,
        },
      ];
    }

    // If one detection covers almost the whole frame, keep it
    // If multiple, crop each with a small pad
    const crops = [];
    for (let i = 0; i < detections.length; i++) {
      const box = detections[i];
      const padX = Math.round(box.width * 0.03);
      const padY = Math.round(box.height * 0.03);
      const left = Math.max(0, box.x - padX);
      const top = Math.max(0, box.y - padY);
      const width = Math.min(imgW - left, box.width + padX * 2);
      const height = Math.min(imgH - top, box.height + padY * 2);

      const crop = await sharp(normalized)
        .extract({ left, top, width, height })
        .jpeg({ quality: 92 })
        .toBuffer();

      const previewJpeg = await sharp(crop)
        .resize({ width: 360, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      crops.push({
        index: i,
        box: { x: left, y: top, width, height },
        buffer: crop,
        previewJpeg,
      });
    }

    return crops;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
