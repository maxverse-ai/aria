import { blog } from '@/lib/source';
import { notFound } from 'next/navigation';
import { generateOGImage } from 'fumadocs-ui/og';
import { appName, getChangelogImageUrl } from '@/lib/shared';

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: RouteContext<'/[lang]/og/changelog/[...slug]'>,
) {
  const { slug, lang } = await params;
  const page = blog.getPage(slug.slice(0, -1), lang);
  if (!page) notFound();

  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: appName,
  });
}

export function generateStaticParams() {
  return blog.getLanguages().flatMap(({ language, pages }) =>
    pages.map((page) => ({
      lang: language,
      slug: getChangelogImageUrl(page).segments,
    })),
  );
}
