/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          // DEFAULT/foreground are the brand green, as literal hex —
          // NOT routed through --primary/--primary-foreground like the
          // rest of shadcn's semantic tokens below, deliberately, so
          // there's no HSL round-trip conversion to get subtly wrong.
          // shadcn's Button `default` variant (bg-primary text-primary-
          // foreground) resolves to this brand green as a result.
          DEFAULT: "#2d5f3f",
          foreground: "#ffffff",
          50: "#f0f7f0",
          100: "#dcecdc",
          500: "#2d5f3f",
          600: "#1f4a30",
          700: "#153421",
        },
        accent: {
          50: "#faf8f2",
          100: "#f5f1e6",
          200: "#ede4c9",
        },
        orange: {
          500: "#d97742",
          600: "#b85f34",
        },
        // shadcn/ui semantic tokens — populated by `shadcn init` writing
        // CSS variables into src/index.css; declared here so Tailwind
        // generates the bg-border/bg-input/etc utility classes shadcn's
        // own component source references.
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
