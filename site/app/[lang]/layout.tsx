import { RootProvider } from 'fumadocs-ui/provider/next';
import '../global.css';
import { Inter, Noto_Sans_SC } from 'next/font/google';
import { i18n } from '@/lib/i18n';
import { siteUrl } from '@/lib/shared';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
};

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

// Inter ships no CJK glyphs; without an explicit fallback Chinese pages
// render in whatever system font the browser picks. Noto Sans SC keeps the
// zh pages typographically consistent with the en pages.
const notoSansSC = Noto_Sans_SC({
  variable: '--font-noto-sc',
});

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function Layout({
  children,
  params,
}: LayoutProps<'/[lang]'>) {
  const { lang } = await params;

  return (
    <html
      lang={lang}
      className={`${inter.variable} ${notoSansSC.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider
          theme={{ defaultTheme: 'dark', enableSystem: false }}
          i18n={i18n.provider(lang)}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
