import Link from 'fumadocs-core/link';
import type { Metadata } from 'next';

const copy: Record<
  string,
  { tagline: string; docs: string; blog: string }
> = {
  en: {
    tagline:
      'A local-first control plane for coding agents. Chat is the remote control, not the compute plane.',
    docs: 'Read the docs',
    blog: 'Changelog',
  },
  zh: {
    tagline: '本地优先的编码智能体控制平面。聊天是遥控器，而不是计算平面。',
    docs: '阅读文档',
    blog: '更新日志',
  },
};

export async function generateMetadata(
  props: PageProps<'/[lang]'>,
): Promise<Metadata> {
  const { lang } = await props.params;
  return {
    alternates: {
      canonical: lang === 'zh' ? '/zh' : '/',
      languages: { en: '/', zh: '/zh', 'x-default': '/' },
    },
  };
}

export default async function HomePage(props: PageProps<'/[lang]'>) {
  const { lang } = await props.params;
  const t = copy[lang] ?? copy.en;
  const prefix = lang === 'zh' ? '/zh' : '';

  return (
    <div className="flex flex-col justify-center text-center flex-1 px-6">
      <h1 className="text-4xl font-bold mb-4">Aria</h1>
      <p className="text-fd-muted-foreground max-w-xl mx-auto mb-8">
        {t.tagline}
      </p>
      <div className="flex flex-row justify-center gap-3">
        <Link
          href={`${prefix}/docs`}
          className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
        >
          {t.docs}
        </Link>
        <Link
          href={`${prefix}/changelog`}
          className="rounded-lg border px-5 py-2.5 font-medium"
        >
          {t.blog}
        </Link>
        <a
          href="https://github.com/maxverse-ai/aria"
          className="rounded-lg border px-5 py-2.5 font-medium"
        >
          GitHub
        </a>
      </div>
    </div>
  );
}
