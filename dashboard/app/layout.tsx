import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EGX LLM Paper Trader",
  description: "A hands-off LLM-driven paper trading experiment on the Egyptian Exchange. Fake money, real prices.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
