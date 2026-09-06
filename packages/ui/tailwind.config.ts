import type { Config } from "tailwindcss";

/**
 * Tailwind v3 compatibility layer.
 *
 * v4 apps do NOT need this file -- `@repo/ui/styles` carries the whole
 * configuration in CSS via `@theme`, and `content` was replaced by `@source`.
 * This preset exists so an app pinned to v3 (Expo/NativeWind is the usual
 * reason) resolves the same token names against the same CSS variables.
 *
 * Consume it from the app's own config:
 *
 *   import preset from "@repo/ui/tailwind.config";
 *   export default { presets: [preset], content: [...] };
 */
const preset = {
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        background: "var(--background)",
        border: "var(--border)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        destructive: "var(--destructive)",
        foreground: "var(--foreground)",
        input: "var(--input)",
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        ring: "var(--ring)",
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
      },
    },
  },
} satisfies Config;

export default preset;
