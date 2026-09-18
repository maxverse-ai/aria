import { docsLlms } from '@/lib/source';
import blogIndex from '@/lib/generated/blog-index.json';

export const revalidate = false;

export async function GET() {
  const index = await docsLlms.index();
  const posts = (blogIndex as { slug: string[]; title: string }[])
    .map((entry) => `- [${entry.title}](/blog/${entry.slug.join('/')})`)
    .join('\n');

  return new Response(`${index}\n\n# Blog & Release Notes\n\n${posts}`);
}
