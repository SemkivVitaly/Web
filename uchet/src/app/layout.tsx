import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { PwaRegister } from "@/components/pwa-register";

export const viewport: Viewport = {
  themeColor: "#2a78d6",
};

export const metadata: Metadata = {
  title: "Производственный учёт · УТК (только для локального использования)",
  description: "Журнал актов, контроль качества и живая статистика производства.",
  keywords: ["акты", "журнал", "производство", "учёт", "контроль качества"],
  authors: [{ name: "Производственный учёт" }],
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Учёт",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/logo.svg",
    apple: "/icon-192.png",
  },
  openGraph: {
    title: "Производственный учёт · УТК (только для локального использования)",
    description: "Журнал актов и живая статистика производства",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <PwaRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
