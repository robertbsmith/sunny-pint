/**
 * Lucide icon rendering — only imports the icons we use.
 */

import { createIcons, MapPin, Play, Pause, Search, Sun, Moon, Monitor } from "lucide";

const usedIcons = { MapPin, Play, Pause, Search, Sun, Moon, Monitor };

export function initIcons(): void {
  const theme = localStorage.getItem("theme") || "system";

  const locateBtn = document.getElementById("btn-locate");
  if (locateBtn) {
    locateBtn.innerHTML = '<i data-lucide="map-pin"></i>';
  }

  const playIcon = document.getElementById("play-icon");
  if (playIcon) {
    playIcon.innerHTML = '<i data-lucide="play"></i>';
  }

  const searchIcon = document.getElementById("search-icon");
  if (searchIcon) {
    searchIcon.innerHTML = '<i data-lucide="search"></i>';
  }

  const themeBtn = document.getElementById("btn-theme");
  if (themeBtn) {
    const iconName = theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor";
    themeBtn.innerHTML = `<i data-lucide="${iconName}"></i>`;
  }

  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}

export function setPlayIcon(playing: boolean): void {
  const playIcon = document.getElementById("play-icon");
  if (!playIcon) return;
  playIcon.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}"></i>`;
  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}
