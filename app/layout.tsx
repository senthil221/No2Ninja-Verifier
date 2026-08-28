import type { ReactNode } from "react";
import Link from "next/link";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { getSessionUser } from "@/lib/auth";
import SignOut from "./SignOut";
import "./globals.css";

const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "Waterfall Verifier",
  description: "Prospect list email verification orchestration",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();

  // Sign-in and first-run setup render on their own, without the app shell:
  // a sidebar full of navigation is noise on a page you cannot yet use.
  if (!user) {
    return (
      <html lang="en" className={`${sans.variable} ${mono.variable}`}>
        <body>{children}</body>
      </html>
    );
  }

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="app-shell">
          <aside className="sidebar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="brand-word">Waterfall</span>
            </Link>

            <nav className="sidebar-nav">
              <Link href="/">Clients</Link>
              <Link href="/usage">Usage</Link>
              <Link href="/settings">Settings</Link>
            </nav>

            <div className="sidebar-foot">
              <SignOut email={user.email} />
            </div>
          </aside>
          <main className="main">
            <div className="main-inner">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
