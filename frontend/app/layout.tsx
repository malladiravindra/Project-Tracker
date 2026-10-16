import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Executive Dashboard",
  description: "Company overview: project health, deadlines and team load",
};

// Applies the saved theme before first paint to avoid a light/dark flash.
const themeScript = `(function(){try{var t=localStorage.getItem('theme')||'light';var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
