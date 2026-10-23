const cameraInput = document.getElementById("camera-input");
const libraryInput = document.getElementById("library-input");
const workspace = document.getElementById("workspace");
const previewImg = document.getElementById("preview-img");
const previewEyebrow = document.getElementById("preview-eyebrow");
const pageSummary = document.getElementById("page-summary");
const pageTotal = document.getElementById("page-total");
const pageTotalAmount = document.getElementById("page-total-amount");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error-box");
const slotGrid = document.getElementById("slot-grid");
const detailPanel = document.getElementById("detail-panel");
const searchForm = document.getElementById("search-form");
const searchResults = document.getElementById("search-results");

let latestDetections = [];
let activeIndex = 0;

function money(amount, currency = "USD") {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `$${Number(amount).toFixed(2)}`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setLoading(message) {
  statusEl.hidden = false;
  statusEl.innerHTML = `<div class="spinner" aria-hidden="true"></div><p>${escapeHtml(message)}</p>`;
  errorEl.hidden = true;
  slotGrid.hidden = true;
  detailPanel.hidden = true;
  pageTotal.hidden = true;
}

function showError(message) {
  statusEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

/**
 * Normalize gallery photos (including iPhone HEIC) to JPEG before upload.
 */
async function toUploadableImage(file) {
  if (!file) throw new Error("No photo selected");

  const isHeic =
    /heic|heif/i.test(file.type) || /\.heic$|\.heif$/i.test(file.name);
  const needsConvert =
    isHeic || !/^image\/(jpeg|png|webp|gif)$/i.test(file.type);

  if (!needsConvert && file.size < 12 * 1024 * 1024) {
    return file;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(
          new Error(
            isHeic
              ? "Couldn't read HEIC — switch iPhone camera to Most Compatible (JPEG), or pick a JPEG/PNG."
              : "Couldn't read that image"
          )
        );
      el.src = objectUrl;
    });

    const maxEdge = 2400;
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9)
    );
    if (!blob) throw new Error("Image conversion failed");
    return new File([blob], "binder.jpg", { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function cardLabel(card) {
  if (!card) return "Unmatched";
  return card.name || "Unknown";
}

function cardSetLine(card) {
  if (!card) return "";
  return [card.year, card.product, card.set, card.number ? `#${card.number}` : null]
    .filter(Boolean)
    .join(" · ");
}

function renderSlotGrid(detections) {
  slotGrid.hidden = false;
  slotGrid.innerHTML = detections
    .map((d, i) => {
      const best = d.best;
      const price =
        best?.headline?.amount != null
          ? money(best.headline.amount, best.headline.currency || "USD")
          : null;
      const miss = !best || price == null;
      return `
        <button type="button" class="slot-card${miss ? " is-miss" : ""}${i === activeIndex ? " is-active" : ""}" data-idx="${i}">
          <img src="${escapeHtml(d.previewDataUrl || "")}" alt="Slot ${i + 1}" />
          <div class="slot-meta">
            <span class="slot-index">Slot ${i + 1}</span>
            <span class="slot-name">${escapeHtml(cardLabel(best))}</span>
            <span class="slot-price">${price ? escapeHtml(price) : d.error ? "Error" : "No price"}</span>
          </div>
        </button>`;
    })
    .join("");

  slotGrid.querySelectorAll(".slot-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeIndex = Number(btn.dataset.idx);
      renderSlotGrid(latestDetections);
      renderDetail(latestDetections[activeIndex]);
    });
  });
}

function renderDetail(detection) {
  if (!detection) {
    detailPanel.hidden = true;
    return;
  }

  const best = detection.best;
  const hints = detection.hints;
  const alts = (detection.cards || []).slice(0, 6);

  if (!best) {
    const guess = hints?.query || hints?.players?.[0] || "";
    detailPanel.hidden = false;
    detailPanel.innerHTML = `
      <img class="detail-art" src="${escapeHtml(detection.previewDataUrl || "")}" alt="Slot crop" />
      <div class="detail-meta">
        <h3>Couldn't lock slot ${(detection.slot ?? detection.index ?? 0) + 1}</h3>
        <p class="setline">${
          guess
            ? `OCR saw “${escapeHtml(guess)}”. Try Manual search below, or retake with the name and number sharp.`
            : `Retake with the player name and card number sharp, or use Manual search.`
        }</p>
        ${
          hints
            ? `<div class="chips">${[...(hints.players || []), ...(hints.brands || []), ...(hints.years || []), ...((hints.numbers || []).map((n) => n.raw || n.number))]
                .slice(0, 8)
                .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${
          detection.error
            ? `<p class="setline" style="color:var(--clay)">${escapeHtml(detection.error)}</p>`
            : ""
        }
      </div>`;
    if (guess && searchForm?.q) searchForm.q.value = guess;
    return;
  }

  const headline = best.headline;
  const priceRows = (best.prices || [])
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.variant || p.source)}</td>
        <td>${money(p.market, p.currency)}</td>
        <td>${money(p.low, p.currency)}</td>
        <td>${money(p.mid, p.currency)}</td>
        <td>${money(p.high, p.currency)}</td>
      </tr>`
    )
    .join("");

  const links = [];
  if (best.links?.sportscardspro) {
    links.push(
      `<a href="${escapeHtml(best.links.sportscardspro)}" target="_blank" rel="noopener">SportsCardsPro</a>`
    );
  }
  if (best.links?.ebaySold) {
    links.push(
      `<a href="${escapeHtml(best.links.ebaySold)}" target="_blank" rel="noopener">eBay sold</a>`
    );
  }
  if (best.links?.catalog || best.url) {
    links.push(
      `<a href="${escapeHtml(best.links?.catalog || best.url)}" target="_blank" rel="noopener">Catalogue</a>`
    );
  }

  const altHtml =
    alts.length > 1
      ? `<h4 style="margin:1rem 0 0;font-size:0.85rem;color:var(--ink-dim);text-transform:uppercase;letter-spacing:0.08em">Not this print?</h4>
         <div class="alt-list">
           ${alts
             .map((c, i) => {
               const price =
                 c.headline?.amount != null
                   ? money(c.headline.amount, c.headline.currency || "USD")
                   : "—";
               return `
                 <button type="button" class="alt-item" data-alt="${i}">
                   <img src="${escapeHtml(c.image || detection.previewDataUrl || "")}" alt="" />
                   <div>
                     <strong>${escapeHtml(c.name)}</strong>
                     <span>${escapeHtml(cardSetLine(c))}</span>
                   </div>
                   <div class="alt-price">${price}</div>
                 </button>`;
             })
             .join("")}
         </div>`
      : "";

  detailPanel.hidden = false;
  detailPanel.innerHTML = `
    <img class="detail-art" src="${escapeHtml(best.image || detection.previewDataUrl || "")}" alt="${escapeHtml(best.name)}" />
    <div class="detail-meta">
      <h3>${escapeHtml(best.name)}</h3>
      <p class="setline">${escapeHtml(cardSetLine(best))}${best.details ? ` · ${escapeHtml(best.details)}` : ""}</p>
      <div class="price-hero">
        <span class="amount">${headline ? money(headline.amount, headline.currency) : "n/a"}</span>
        <span class="label">${
          headline
            ? `${escapeHtml(headline.variant || "Guide")} · ${escapeHtml(headline.label || cardSetLine(best))}`
            : best.priceError
              ? escapeHtml(best.priceError)
              : "No live guide price found"
        }</span>
      </div>
      ${
        priceRows
          ? `<table class="price-table">
              <thead><tr><th>Guide</th><th>Market</th><th>Low</th><th>Mid</th><th>High</th></tr></thead>
              <tbody>${priceRows}</tbody>
            </table>`
          : ""
      }
      ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
      ${altHtml}
    </div>
  `;

  detailPanel.querySelectorAll(".alt-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.alt);
      const picked = alts[idx];
      if (!picked) return;
      detection.best = picked;
      latestDetections[activeIndex] = detection;
      updatePageTotal(latestDetections);
      renderSlotGrid(latestDetections);
      renderDetail(detection);
    });
  });
}

function updatePageTotal(detections) {
  const valued = detections.filter((d) => d.best?.headline?.amount != null);
  if (!valued.length) {
    pageTotal.hidden = true;
    return;
  }
  const sum = valued.reduce((s, d) => s + Number(d.best.headline.amount), 0);
  pageTotal.hidden = false;
  pageTotalAmount.textContent = money(sum, "USD");
  pageSummary.textContent = `${valued.length} of ${detections.length} slots valued`;
}

async function appraiseFile(file) {
  workspace.hidden = false;
  workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  previewEyebrow.textContent = "Uploading…";
  pageSummary.textContent = "Binder page";

  const objectUrl = URL.createObjectURL(file);
  previewImg.src = objectUrl;

  setLoading("Detecting nine pockets and reading each card… this can take a minute.");

  try {
    const uploadable = await toUploadableImage(file);
    const form = new FormData();
    form.append("image", uploadable, uploadable.name || "binder.jpg");
    form.append("grid", "3x3");

    previewEyebrow.textContent = "Scanning…";

    const res = await fetch("/api/appraise", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Appraisal failed");

    latestDetections = data.detections || [];
    activeIndex = 0;
    statusEl.hidden = true;
    previewEyebrow.textContent = `${data.detectionCount || latestDetections.length} slots`;

    if (data.pageTotal != null) {
      pageTotal.hidden = false;
      pageTotalAmount.textContent = money(data.pageTotal, data.pageTotalCurrency || "USD");
      pageSummary.textContent = `${data.valuedCount} of ${data.detectionCount} slots valued`;
    } else {
      updatePageTotal(latestDetections);
    }

    if (!latestDetections.length) {
      showError("No cards detected. Fill the frame with the binder page and try again.");
      return;
    }

    renderSlotGrid(latestDetections);
    renderDetail(latestDetections[0]);
  } catch (err) {
    console.error(err);
    showError(err.message || "Something went wrong");
  }
}

async function runSearch(query) {
  searchResults.hidden = false;
  searchResults.innerHTML = `<div class="status"><div class="spinner"></div><p>Searching catalogue…</p></div>`;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
    const cards = data.cards || [];
    if (!cards.length) {
      searchResults.innerHTML = `<p class="setline">No matches for “${escapeHtml(query)}”.</p>`;
      return;
    }
    searchResults.innerHTML = `
      <div class="alt-list">
        ${cards
          .map((c) => {
            const price =
              c.headline?.amount != null
                ? money(c.headline.amount, c.headline.currency || "USD")
                : "—";
            const href = c.links?.sportscardspro || c.url || c.links?.ebaySold || "#";
            return `
              <a class="alt-item" href="${escapeHtml(href)}" target="_blank" rel="noopener" style="text-decoration:none">
                <img src="${escapeHtml(c.image || "")}" alt="" />
                <div>
                  <strong>${escapeHtml(c.name)}</strong>
                  <span>${escapeHtml(cardSetLine(c))}</span>
                </div>
                <div class="alt-price">${price}</div>
              </a>`;
          })
          .join("")}
      </div>`;
  } catch (err) {
    searchResults.innerHTML = `<div class="error-box">${escapeHtml(err.message || "Search failed")}</div>`;
  }
}

function onFile(input) {
  const file = input.files?.[0];
  input.value = "";
  if (file) appraiseFile(file);
}

cameraInput?.addEventListener("change", () => onFile(cameraInput));
libraryInput?.addEventListener("change", () => onFile(libraryInput));

searchForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = String(new FormData(searchForm).get("q") || "").trim();
  if (q) runSearch(q);
});
