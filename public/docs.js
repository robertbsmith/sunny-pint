// Theme bootstrap: read the same localStorage key as the main app and apply
// .dark to <html> before paint. Also wires the mobile sidebar drawer toggle
// and active-section highlight in the table of contents.
(() => {
  function applyTheme() {
    const stored = localStorage.getItem("theme") || "system";
    const dark =
      stored === "dark" ||
      (stored === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }
  window.addEventListener("storage", (e) => {
    if (e.key === "theme") applyTheme();
  });

  document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.querySelector(".sidebar");
    const toggle = document.querySelector(".sidebar-toggle");
    const backdrop = document.querySelector(".sidebar-backdrop");
    if (sidebar && toggle && backdrop) {
      const open = () => {
        sidebar.classList.add("open");
        backdrop.classList.add("open");
      };
      const close = () => {
        sidebar.classList.remove("open");
        backdrop.classList.remove("open");
      };
      toggle.addEventListener("click", () => {
        if (sidebar.classList.contains("open")) close();
        else open();
      });
      backdrop.addEventListener("click", close);
      sidebar.addEventListener("click", (e) => {
        if (e.target.tagName === "A" && e.target.getAttribute("href").charAt(0) === "#") close();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });
    }

    // Active-section highlight on scroll.
    const sectionLinks = document.querySelectorAll('.sidebar a[href^="#"]');
    if (sectionLinks.length === 0) return;
    const sections = [];
    sectionLinks.forEach((a) => {
      const id = a.getAttribute("href").slice(1);
      const el = document.getElementById(id);
      if (el) sections.push({ id, el, link: a });
    });
    function onScroll() {
      const scrollY = window.scrollY + 80;
      let current = sections[0];
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].el.offsetTop <= scrollY) current = sections[i];
      }
      sectionLinks.forEach((a) => {
        a.classList.remove("active");
      });
      if (current) current.link.classList.add("active");
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  });
})();
