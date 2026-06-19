/** Quill desktop color themes */

const THEMES = {
  dark: {
    label: "Dark",
    cssClass: "theme-dark",
    terminal: { background: "#14141c", foreground: "#e8e8f0", cursor: "#7eb8ff" },
    vars: {},
  },
  imode: {
    label: "i mode (Light)",
    cssClass: "theme-imode",
    terminal: { background: "#ffffff", foreground: "#1a1a24", cursor: "#2a7ab8" },
    vars: {},
  },
  midnight: {
    label: "Midnight",
    cssClass: "theme-midnight",
    terminal: { background: "#0a0e17", foreground: "#c8d6e5", cursor: "#54a0ff" },
    vars: { "--bg": "#0a0e17", "--bg-panel": "#111827", "--bg-header": "#1a2332", "--border": "#243044", "--accent": "#54a0ff", "--accent-purple": "#748ffc" },
  },
  ocean: {
    label: "Ocean",
    cssClass: "theme-ocean",
    terminal: { background: "#0b1d26", foreground: "#d0f0fd", cursor: "#22b8cf" },
    vars: { "--bg": "#0b1d26", "--bg-panel": "#102a33", "--bg-header": "#15343f", "--border": "#1f4d5c", "--accent": "#22b8cf", "--accent-purple": "#66d9e8" },
  },
  sunset: {
    label: "Sunset",
    cssClass: "theme-sunset",
    terminal: { background: "#1a0f14", foreground: "#ffe8d6", cursor: "#ff922b" },
    vars: { "--bg": "#1a0f14", "--bg-panel": "#241018", "--bg-header": "#2d141e", "--border": "#4a2030", "--accent": "#ff922b", "--accent-purple": "#ff6b6b" },
  },
  forest: {
    label: "Forest",
    cssClass: "theme-forest",
    terminal: { background: "#0f1a14", foreground: "#d3f9d8", cursor: "#1dd1a1" },
    vars: { "--bg": "#0f1a14", "--bg-panel": "#152019", "--bg-header": "#1a2820", "--border": "#2a4034", "--accent": "#1dd1a1", "--accent-purple": "#63e6be" },
  },
};

module.exports = { THEMES };
