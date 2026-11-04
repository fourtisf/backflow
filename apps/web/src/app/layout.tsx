import { BRAND, META_DESCRIPTION } from "@backflow/core";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import { Footer, Header, ShellExtras } from "@/components/Shell";
import "./globals.css";
import "./app.css";

export const metadata: Metadata = {
  title: { default: `${BRAND.name}: ${BRAND.tagline}`, template: `%s · ${BRAND.name}` },
  description: META_DESCRIPTION,
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050817",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@500;600;700&family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <defs>
            <linearGradient id="gFlow" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#8F9CFF" />
              <stop offset="1" stopColor="#45E3D3" />
            </linearGradient>
            <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3DDC97" stopOpacity=".30" />
              <stop offset="1" stopColor="#3DDC97" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gDn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#FF5C7A" stopOpacity=".26" />
              <stop offset="1" stopColor="#FF5C7A" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
        <Providers>
          <Header />
          <main id="app" tabIndex={-1}>
            {children}
          </main>
          <Footer />
          <ShellExtras />
        </Providers>
      </body>
    </html>
  );
}
