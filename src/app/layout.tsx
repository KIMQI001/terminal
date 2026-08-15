import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Trading Terminal",
  description: "Professional trading terminal with ICT indicators",
  icons: {
    icon: "/favicon.svg",
  },
};

// iPad/iOS 触摸适配:禁用双击缩放和 300ms 延迟,让 onDoubleClick 正常工作
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
