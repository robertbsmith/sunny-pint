/**
 * Lucide icon rendering — only imports the icons we use.
 */

import {
  createIcons,
  MapPin,
  Moon,
  Navigation,
  Pause,
  Play,
  Search,
  Share2,
  Sun,
  SunMoon,
} from "lucide";

const usedIcons = { MapPin, Play, Pause, Search, Sun, Moon, SunMoon, Navigation, Share2 };

export function initIcons(): void {
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

  const shareBtn = document.getElementById("btn-share");
  if (shareBtn) {
    shareBtn.innerHTML = '<i data-lucide="share-2"></i>';
  }

  const directionsBtn = document.getElementById("btn-directions");
  if (directionsBtn) {
    directionsBtn.innerHTML = '<i data-lucide="navigation"></i>';
  }

  const searchBtn = document.getElementById("btn-search");
  if (searchBtn) {
    searchBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
  }

  updateThemeIcon();

  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}

export function updateThemeIcon(): void {
  const theme = localStorage.getItem("theme") || "system";
  const themeIcon = document.getElementById("theme-icon");
  if (themeIcon) {
    const iconName = theme === "dark" ? "moon" : theme === "light" ? "sun" : "sun-moon";
    themeIcon.innerHTML = `<i data-lucide="${iconName}"></i>`;
  }
  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (themeSelect) {
    themeSelect.value = theme;
  }
  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}

export function setPlayIcon(playing: boolean): void {
  const playIcon = document.getElementById("play-icon");
  if (!playIcon) return;
  playIcon.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}"></i>`;
  createIcons({ icons: usedIcons, attrs: { width: 18, height: 18, "stroke-width": 2 } });
}
