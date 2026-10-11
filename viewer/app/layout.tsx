import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NocoBase · 增长报告",
  description: "阅读 NocoBase 每日增长报告与页面 SEO 巡检，查看历史日报。",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
