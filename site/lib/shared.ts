import { createGetUrl } from 'fumadocs-core/source';
import { i18n } from './i18n';

export const appName = 'Aria';
export const siteUrl = 'https://docs.example.com';
export const docsRoute = '/docs';
export const blogRoute = '/changelog';
export const docsImageRoute = '/og/docs';
export const blogImageRoute = '/og/changelog';
export const docsContentRoute = '/llms.mdx/docs';
export const blogContentRoute = '/llms.mdx/changelog';

export const gitConfig = {
  user: 'maxverse-ai',
  repo: 'aria',
  branch: 'main',
};

const getContentUrl = createGetUrl(docsContentRoute, i18n);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getBlogContentUrl = createGetUrl(blogContentRoute, i18n);

export function getBlogMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getBlogContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute, i18n);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}

const getBlogImageUrl = createGetUrl(blogImageRoute, i18n);

export function getChangelogImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getBlogImageUrl(segments, page.locale) };
}

// Locale-aware page URLs for canonical/hreflang metadata and the sitemap.
const getDocsPageUrl = createGetUrl(docsRoute, i18n);
const getChangelogPageUrl = createGetUrl(blogRoute, i18n);

export function getLocalizedDocsUrl(slugs: string[], locale: string) {
  return getDocsPageUrl(slugs, locale);
}

export function getLocalizedChangelogUrl(slugs: string[], locale: string) {
  return getChangelogPageUrl(slugs, locale);
}
