/**
 * Lucide icon rendering — only imports the icons we use.
 */

import { createIcons, MapPin, Navigation, Pause, Play, Search, Share2 } from "lucide";

const usedIcons = { MapPin, Play, Pause, Search, Navigation, Share2 };

/** Render all Lucide icons in the page on startup. */
export function initIcons(): void {
  const gpsIcon = document.getElementById("gps-icon");
  if (gpsIcon) {
    gpsIcon.innerHTML = '<i data-lucide="map-pin"></i>';
  }

  const playIcon = document.getElementById("play-icon");
  if (playIcon) {
    playIcon.innerHTML = '<i data-lucide="play"></i>';
  }

  const shareBtn = document.getElementById("btn-share");
  if (shareBtn) {
    shareBtn.innerHTML = '<i data-lucide="share-2"></i>';
  }

  const directionsBtn = document.getElementById("btn-directions");
  if (directionsBtn) {
    directionsBtn.innerHTML = '<i data-lucide="navigation"></i>';
  }

  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}

/** Set the play/pause icon. */
export function setPlayIcon(playing: boolean): void {
  const playIcon = document.getElementById("play-icon");
  if (!playIcon) return;
  playIcon.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}"></i>`;
  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}
