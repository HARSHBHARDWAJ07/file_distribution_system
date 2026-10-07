import { Instrument_Sans } from 'next/font/google';
import './globals.css';

// One family for everything: hierarchy comes from size and weight, not from
// a second typeface competing for attention.
const instrument = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans', display: 'swap' });

export const metadata = {
  title: 'CloudStore',
  description: 'Upload, keep and download your files. Large files travel in parts, straight to storage.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={instrument.variable}>
      <body>{children}</body>
    </html>
  );
}
