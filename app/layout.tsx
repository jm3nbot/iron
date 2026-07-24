import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ink & Iron — Personal Command Center",
  description:
    "A quiet place to capture thoughts, choose what matters, and move.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
