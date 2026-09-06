import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  description: "Turborepo + Bun monorepo running on Next.js, Elysia and Expo.",
  title: {
    default: "Astro",
    template: "%s | Astro",
  },
};

/**
 * Server Component by default -- no "use client" here. It renders on the
 * server only, so nothing in this file is shipped to the browser.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
