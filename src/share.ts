/**
 * Share — capture porthole + sign as a shareable image with caption.
 * Uses Web Share API on mobile, fallback to download.
 */

import { state, selectedPub, pubCenter } from "./state";
import { renderCircle, sizeCanvas } from "./circle";
import { weatherLabel, weatherEmoji } from "./weather";
import SunCalc from "suncalc";

/** Generate a share image and trigger share/download. */
export async function shareSnapshot(): Promise<void> {
  const pub = selectedPub();
  if (!pub) return;

  // Square image optimised for WhatsApp/social sharing.
  const canvas = document.createElement("canvas");
  const w = 540;
  const h = 540;
  const dpr = 2;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  // Background.
  ctx.fillStyle = "#1A1A1A";
  ctx.fillRect(0, 0, w, h);

  // Pub name at top — auto-size to fill width.
  let nameFontSize = 32;
  ctx.font = `bold ${nameFontSize}px Georgia, serif`;
  while (ctx.measureText(pub.name).width > w - 40 && nameFontSize > 16) {
    nameFontSize--;
    ctx.font = `bold ${nameFontSize}px Georgia, serif`;
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#F59E0B";
  ctx.fillText(pub.name, w / 2, nameFontSize + 8);

  // Render the porthole onto a temp canvas.
  const portholeCanvas = document.createElement("canvas");
  const portholeW = 440;
  const portholeH = Math.round(portholeW * 1.2);
  portholeCanvas.width = portholeW;
  portholeCanvas.height = portholeH;
  renderCircle(portholeCanvas);

  // Draw porthole centred below title.
  const px = (w - portholeW) / 2;
  const py = 44;
  ctx.drawImage(portholeCanvas, px, py);

  // Caption at bottom.
  const total = Math.round(state.timeMins);
  const hours = Math.floor(total / 60) % 24;
  const mins = total % 60;
  const timeStr = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;

  const d = new Date(state.date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(state.timeMins);
  const sun = SunCalc.getPosition(d, pub.lat, pub.lng);
  const altitude = (sun.altitude * 180) / Math.PI;
  const isDay = altitude > 0;

  const weather = weatherLabel(state.weatherState);
  const emoji = weatherEmoji(state.weatherState);

  // Status line.
  ctx.font = "400 18px system-ui, sans-serif";
  ctx.fillStyle = "#9E9892";
  ctx.textAlign = "left";
  const statusText = isDay
    ? `${emoji} ${weather} at ${timeStr}`
    : `Night at ${timeStr}`;
  ctx.fillText(statusText, 16, h - 16);

  // Domain.
  ctx.font = "bold 16px Georgia, serif";
  ctx.fillStyle = "#D97706";
  ctx.textAlign = "right";
  ctx.fillText("sunny-pint.co.uk", w - 16, h - 16);

  // Convert to blob.
  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), "image/png");
  });

  const file = new File([blob], `sunny-pint-${pub.name.toLowerCase().replace(/\s+/g, "-")}.png`, { type: "image/png" });

  // Build share text.
  const shareText = isDay
    ? `${emoji} ${pub.name} — ${weather.toLowerCase()} right now! Check the sun at sunny-pint.co.uk`
    : `Checking out ${pub.name} on Sunny Pint — sunny-pint.co.uk`;

  // Try Web Share API (mobile native share sheet).
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        text: shareText,
        files: [file],
      });
      return;
    } catch {
      // User cancelled or share failed — fall through to download.
    }
  }

  // Fallback: show a share dialog with image + copyable link.
  showShareDialog(blob, shareText, pub.name);
}

function showShareDialog(imageBlob: Blob, shareText: string, pubName: string): void {
  // Remove existing dialog.
  document.getElementById("share-dialog")?.remove();

  const imgUrl = URL.createObjectURL(imageBlob);

  const overlay = document.createElement("div");
  overlay.id = "share-dialog";
  overlay.innerHTML = `
    <div class="share-dialog-backdrop"></div>
    <div class="share-dialog-content">
      <button class="share-dialog-close" title="Close">&times;</button>
      <img src="${imgUrl}" alt="Share preview" />
      <div class="share-dialog-actions">
        <button class="share-btn-copy" title="Copy link">Copy link</button>
        <button class="share-btn-download" title="Download image">Download image</button>
      </div>
      <input class="share-dialog-link" type="text" readonly value="${window.location.href}" />
    </div>
  `;

  document.body.appendChild(overlay);

  // Close.
  const close = () => {
    overlay.remove();
    URL.revokeObjectURL(imgUrl);
  };
  overlay.querySelector(".share-dialog-backdrop")!.addEventListener("click", close);
  overlay.querySelector(".share-dialog-close")!.addEventListener("click", close);

  // Copy link.
  overlay.querySelector(".share-btn-copy")!.addEventListener("click", () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      const btn = overlay.querySelector(".share-btn-copy") as HTMLButtonElement;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy link"; }, 1500);
    });
  });

  // Download.
  overlay.querySelector(".share-btn-download")!.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = `sunny-pint-${pubName.toLowerCase().replace(/\s+/g, "-")}.png`;
    a.click();
  });

  // Select link text on click.
  const linkInput = overlay.querySelector(".share-dialog-link") as HTMLInputElement;
  linkInput.addEventListener("click", () => linkInput.select());
}
