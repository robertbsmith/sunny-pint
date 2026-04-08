/**
 * SunPub — find sunny beer gardens.
 *
 * Entry point. Wires together map, circle view, controls, and data loading.
 */

import "./style.css";

// TODO: Wire up modules as we migrate from the monolithic HTML file.
// For now, this is a placeholder entry point.

console.log("SunPub loading...");

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="flex h-screen">
    <div id="map" class="flex-1"></div>
    <div id="panel" class="w-80 border-l border-gray-200 bg-white overflow-y-auto p-4">
      <h1 class="text-xl font-bold">SunPub</h1>
      <p class="text-sm text-gray-500 mb-4">Find sunny beer gardens</p>
      <p class="text-sm text-gray-400">Migrating to TypeScript + MapLibre...</p>
    </div>
  </div>
`;
