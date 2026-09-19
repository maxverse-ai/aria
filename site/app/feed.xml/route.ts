import { blogRoute, siteUrl } from '@/lib/shared';
import blogIndexJson from '@/lib/generated/blog-index.json';
import lastmodJson from '@/lib/generated/lastmod.json';

export const dynamic = 'force-static';

const lastmod = lastmodJson as Record<string, string>;
const blogIndex = blogIndexJson as {
  slug: string[];
  title: string;
  date: string | null;
}[];

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function GET() {
  const items = blogIndex
    .map((entry) => {
      const slug = entry.slug.join('/');
      const url = `${siteUrl}${blogRoute}/${slug}`;
      const date =
        entry.date ??
        lastmod[`blog:en:${slug}`] ??
        lastmod[`blog:${slug}`];
      return [
        '    <item>',
        `      <title>${escapeXml(entry.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        date
          ? `      <pubDate>${new Date(date).toUTCString()}</pubDate>`
          : null,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Aria Changelog</title>
    <link>${siteUrl}${blogRoute}</link>
    <description>Release notes for Aria.</description>
    <language>en</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
