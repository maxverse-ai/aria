import { blog, blogLlms } from '@/lib/source';
import { getBlogMarkdownUrl } from '@/lib/shared';
import { notFound } from 'next/navigation';

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: RouteContext<'/[lang]/llms.mdx/blog/[[...slug]]'>,
) {
  const { slug, lang } = await params;
  const page = blog.getPage(slug?.slice(0, -1), lang);
  if (!page) notFound();

  return new Response(await blogLlms.page(page), {
    headers: {
      'Content-Type': 'text/markdown',
    },
  });
}

export function generateStaticParams() {
  return blog.getLanguages().flatMap(({ language, pages }) =>
    pages.map((page) => ({
      lang: language,
      slug: getBlogMarkdownUrl(page).segments,
    })),
  );
}
