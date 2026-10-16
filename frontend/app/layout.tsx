import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'EcoTwin | Campus Digital Twin', description: 'Explore campus recycling through an interactive digital twin.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
