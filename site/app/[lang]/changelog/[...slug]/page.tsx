import { blog } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  PageLastUpdate,
  EditOnGitHub,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
  getBlogMarkdownUrl,
  getChangelogImageUrl,
  getLocalizedChangelogUrl,
  gitConfig,
} from '@/lib/shared';
import sourceMap from '@/lib/generated/source-map.json';
import lastmodMap from '@/lib/generated/lastmod.json';

export default async function Page(
  props: PageProps<'/[lang]/changelog/[...slug]'>,
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
  const lastmod =
    (lastmodMap as Record<string, string>)[
      `blog:${page.locale}:${page.slugs.join('/')}`
    ] ?? (lastmodMap as Record<string, string>)[`blog:${page.slugs.join('/')}`];

  return (
    <DocsLayout tree={blog.getPageTree(params.lang)} {...baseOptions(params.lang)}>
      <DocsPage
        toc={page.data.toc}
        full={page.data.full}
        tableOfContent={{ style: 'clerk' }}
      >
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0">
            {page.data.description}
          </DocsDescription>
          <div className="flex flex-row gap-2 items-center border-b pb-6">
            <MarkdownCopyButton markdownUrl={markdownUrl} />
            <EditOnGitHub
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}/edit/${gitConfig.branch}/${repoPath}`}
            />
          </div>
        <DocsBody>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(blog, page),
            })}
          />
        </DocsBody>
        {lastmod && <PageLastUpdate date={new Date(lastmod)} />}
      </DocsPage>
    </DocsLayout>
  );
}

export async function generateStaticParams() {
  return blog.generateParams();
}

export async function generateMetadata(
  props: PageProps<'/[lang]/changelog/[...slug]'>,
): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage(params.slug, params.lang);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      languages: {
        en: getLocalizedChangelogUrl(page.slugs, 'en'),
        zh: getLocalizedChangelogUrl(page.slugs, 'zh'),
        'x-default': getLocalizedChangelogUrl(page.slugs, 'en'),
      },
    },
    openGraph: {
      images: getChangelogImageUrl(page).url,
    },
  };
}
