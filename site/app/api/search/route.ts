import { blog, source } from '@/lib/source';
import { i18n } from '@/lib/i18n';
import { createI18nSearchAPI } from 'fumadocs-core/search/server';
import type { AdvancedIndex } from 'fumadocs-core/search/server';

interface TreeNode {
  name?: unknown;
  type?: string;
  url?: string;
  children?: TreeNode[];
}

function findPath(
  nodes: TreeNode[],
  url: string,
  trail: TreeNode[] = [],
): TreeNode[] | undefined {
  for (const node of nodes) {
    const next = [...trail, node];
    if (node.type === 'page' && node.url === url) return next;
    if (node.children) {
      const found = findPath(node.children, url, next);
      if (found) return found;
    }
  }
  return undefined;
}

// Mirrors fumadocs' internal buildBreadcrumbs so docs and changelog results
// carry the same "Aria Docs > Section" trail.
function breadcrumbs(
  loader: { getPageTree: (locale?: string) => { name?: unknown; children: TreeNode[] } },
  page: { url: string; locale?: string },
) {
  const tree = loader.getPageTree(page.locale);
  const path = findPath(tree.children, page.url);
  if (!path) return undefined;
  path.pop();
  const crumbs: string[] = [];
  if (typeof tree.name === 'string' && tree.name) crumbs.push(tree.name);
  for (const node of path) {
    if (typeof node.name === 'string' && node.name) crumbs.push(node.name);
  }
  return crumbs;
}

interface IndexablePage {
  url: string;
  locale?: string;
  data: {
    title?: string;
    description?: string;
    structuredData?: unknown;
    load?: () => Promise<{ structuredData?: unknown }>;
  };
}

// createI18nSearchAPI requires a non-optional locale on every index record.
type LocalizedIndex = AdvancedIndex & { locale: string };

async function toIndex(
  loader: { getPageTree: (locale?: string) => { name?: unknown; children: TreeNode[] } },
  page: IndexablePage,
): Promise<LocalizedIndex> {
  const data = page.data;
  const structuredData = data.structuredData
    ? typeof data.structuredData === 'function'
      ? await (data.structuredData as () => Promise<unknown>)()
      : data.structuredData
    : typeof data.load === 'function'
      ? (await data.load()).structuredData
      : undefined;
  if (!structuredData) {
    throw new Error(`cannot index ${page.url}: no structured data`);
  }
  return {
    id: page.url,
    title: data.title ?? page.url,
    description: data.description,
    url: page.url,
    breadcrumbs: breadcrumbs(loader, page),
    locale: page.locale ?? i18n.defaultLanguage,
    structuredData,
  } as LocalizedIndex;
}

// One index over both collections so release notes show up in search too;
// locale filtering stays per-language through the i18n index map.
async function buildIndexes() {
  const indexes: LocalizedIndex[] = [];
  for (const loader of [source, blog]) {
    for (const { language, pages } of loader.getLanguages()) {
      for (const page of pages) {
        indexes.push(
          await toIndex(loader, { ...(page as unknown as IndexablePage), locale: language }),
        );
      }
    }
  }
  return indexes;
}

export const { GET } = createI18nSearchAPI('advanced', {
  i18n,
  indexes: () => buildIndexes(),
});
