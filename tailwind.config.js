/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./crypto_screener/dashboard_static/index.html",
    "./crypto_screener/dashboard_static/dashboard.js",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        panel: "var(--panel)",
        "panel-2": "var(--panel-2)",
        line: "var(--line)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        up: "var(--up)",
        down: "var(--down)",
        gold: "var(--gold)",
        warn: "var(--warn)",
        blue: "var(--blue)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SF Mono", "JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
