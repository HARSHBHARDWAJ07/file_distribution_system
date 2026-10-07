import { Bricolage_Grotesque, Atkinson_Hyperlegible } from 'next/font/google';
import './globals.css';

const bricolage = Bricolage_Grotesque({ subsets: ['latin'], weight: ['700', '800'], variable: '--font-bricolage', display: 'swap' });
const atkinson = Atkinson_Hyperlegible({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-atkinson', display: 'swap' });

export const metadata = {
  title: 'CloudStore',
  description: 'Upload, keep and download your files. Large files travel in parts, straight to storage.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${atkinson.variable}`}>
      <body>{children}</body>
    </html>
  );
}
