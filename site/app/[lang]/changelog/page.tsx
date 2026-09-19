import { blog } from '@/lib/source';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import Link from 'fumadocs-core/link';
import blogIndex from '@/lib/generated/blog-index.json';
import type { Metadata } from 'next';

interface BlogIndexEntry {
  slug: string[];
  title: string;
  date: string | null;
}

const titles: Record<string, { title: string; description: string }> = {
  en: {
    title: 'Changelog',
    description: 'Release notes and updates from the Aria project.',
  },
  zh: {
    title: '更新日志',
    description: 'Aria 项目的发布说明与更新。',
  },
};

export default async function BlogIndexPage(
  props: PageProps<'/[lang]/changelog'>,
) {
  const { lang } = await props.params;
  const t = titles[lang] ?? titles.en;

  const entries = (blogIndex as BlogIndexEntry[])
    .map((entry) => {
      const page = blog.getPage(entry.slug, lang);
      if (!page) return null;
      return {
        url: page.url,
        title: page.data.title ?? entry.title,
        description: page.data.description,
        date: entry.date,
      };
    })
    .filter((e) => e !== null);

  return (
    <HomeLayout {...baseOptions(lang)}>
      <main className="flex flex-1 flex-col px-6 py-12 mx-auto w-full max-w-3xl">
      <h1 className="text-3xl font-bold mb-2">{t.title}</h1>
      <p className="text-fd-muted-foreground mb-10">{t.description}</p>
      <ul className="flex flex-col gap-6">
        {entries.map((entry) => (
          <li key={entry.url} className="border-b pb-6">
            <Link
              href={entry.url}
              className="text-xl font-medium hover:underline"
            >
              {entry.title}
            </Link>
            {entry.date ? (
              <p className="text-sm text-fd-muted-foreground mt-1">
                {entry.date}
              </p>
            ) : null}
            {entry.description ? (
              <p className="text-fd-muted-foreground mt-2">
                {entry.description}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      </main>
    </HomeLayout>
  );
}

export async function generateMetadata(
  props: PageProps<'/[lang]/changelog'>,
): Promise<Metadata> {
  const { lang } = await props.params;
  const t = titles[lang] ?? titles.en;
  return { title: t.title, description: t.description };
}
