import type { MetadataRoute } from 'next';
import { blog, source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';
import lastmodJson from '@/lib/generated/lastmod.json';

export const dynamic = 'force-static';

const lastmod = lastmodJson as Record<string, string>;

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];
  const seen = new Set<string>();

  const push = (url: string, modified?: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    entries.push({ url: `${siteUrl}${url}`, lastModified: modified });
  };

  // Locale landing and section index pages; leaf pages are pushed below.
  push('/');
  push('/zh');
  push('/changelog');
  push('/zh/changelog');

  for (const { language, pages } of source.getLanguages()) {
    for (const page of pages) {
      const slug = page.slugs.join('/');
      push(page.url, lastmod[`${language}:${slug}`] ?? lastmod[slug]);
    }
  }

  for (const { language, pages } of blog.getLanguages()) {
    for (const page of pages) {
      const slug = page.slugs.join('/');
      push(
        page.url,
        lastmod[`blog:${language}:${slug}`] ??
          lastmod[`blog:en:${slug}`] ??
          lastmod[`blog:${slug}`],
      );
    }
  }

  return entries;
}
