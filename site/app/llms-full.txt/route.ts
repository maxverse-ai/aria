import { blogLlms, docsLlms } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  // Default-locale pages only: localized trees inherit fallback pages, so
  // rendering every locale would duplicate the English content.
  const [docs, posts] = await Promise.all([
    docsLlms.full('en'),
    blogLlms.full('en'),
  ]);

  return new Response(`${docs}\n\n${posts}`);
}
