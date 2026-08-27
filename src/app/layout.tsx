import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipper",
  description: "Turn long videos into short vertical clips with burned-in captions.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
