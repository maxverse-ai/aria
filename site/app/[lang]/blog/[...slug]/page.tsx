import { blog } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getBlogMarkdownUrl, gitConfig } from '@/lib/shared';
import sourceMap from '@/lib/generated/source-map.json';

export default async function Page(
  props: PageProps<'/[lang]/blog/[...slug]'>,
) {
  const params = await props.params;
  const page = blog.getPage(params.slug, params.lang);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getBlogMarkdownUrl(page).url;
  const repoPath =
    (sourceMap as Record<string, string>)[
      `blog:${page.locale}:${page.slugs.join('/')}`
    ] ??
    (sourceMap as Record<string, string>)[`blog:${page.slugs.join('/')}`] ??
    'docs';

  return (
    <DocsLayout tree={blog.getPageTree(params.lang)} {...baseOptions()}>
      <DocsPage toc={page.data.toc} full={page.data.full}>
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0">
            {page.data.description}
          </DocsDescription>
          <div className="flex flex-row gap-2 items-center border-b pb-6">
            <MarkdownCopyButton markdownUrl={markdownUrl} />
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${repoPath}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-fd-muted-foreground hover:underline"
            >
              GitHub
            </a>
          </div>
        <DocsBody>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(blog, page),
            })}
          />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}

export async function generateStaticParams() {
  return blog.generateParams();
}

export async function generateMetadata(
  props: PageProps<'/[lang]/blog/[...slug]'>,
): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage(params.slug, params.lang);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
