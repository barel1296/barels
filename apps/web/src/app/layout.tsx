import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GROS — AI Growth Operating System',
  description: 'Your AI Growth Team: investigate, decide, prepare, approve.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen text-sm">{children}</body>
    </html>
  );
}
