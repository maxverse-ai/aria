import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
  MarkdownCopyButton,
  PageLastUpdate,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/notebook/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
  getLocalizedDocsUrl,
  getPageImageUrl,
  getPageMarkdownUrl,
  gitConfig,
} from '@/lib/shared';
import sourceMap from '@/lib/generated/source-map.json';
import lastmodMap from '@/lib/generated/lastmod.json';

export default async function Page(
  props: PageProps<'/[lang]/docs/[[...slug]]'>,
) {
  const params = await props.params;
  const page = source.getPage(params.slug, params.lang);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const repoPath =
    (sourceMap as Record<string, string>)[`${page.locale}:${page.slugs.join('/')}`] ??
    (sourceMap as Record<string, string>)[page.slugs.join('/')] ??
    'docs';
  const lastmod =
    (lastmodMap as Record<string, string>)[`${page.locale}:${page.slugs.join('/')}`] ??
    (lastmodMap as Record<string, string>)[page.slugs.join('/')];

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      tableOfContent={{ style: 'clerk' }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} />
        <EditOnGitHub
          href={`https://github.com/${gitConfig.user}/${gitConfig.repo}/edit/${gitConfig.branch}/${repoPath}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      {lastmod && <PageLastUpdate date={new Date(lastmod)} />}
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<'/[lang]/docs/[[...slug]]'>,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug, params.lang);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      languages: {
        en: getLocalizedDocsUrl(page.slugs, 'en'),
        zh: getLocalizedDocsUrl(page.slugs, 'zh'),
        'x-default': getLocalizedDocsUrl(page.slugs, 'en'),
      },
    },
    openGraph: {
      images: getPageImageUrl(page).url,
    },
  };
}
