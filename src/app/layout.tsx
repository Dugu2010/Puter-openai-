import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Puter ⇄ OpenAI Gateway",
  description: "OpenAI-compatible API gateway backed by Puter's free user-pays AI path.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
