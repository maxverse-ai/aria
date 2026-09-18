import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { i18n } from '@/lib/i18n';
import {
  blogContentRoute,
  blogRoute,
  docsContentRoute,
  docsRoute,
} from '@/lib/shared';

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteDocsSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteBlog } = rewritePath(
  `${blogRoute}{/*path}`,
  `${blogContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteBlogSuffix } = rewritePath(
  `${blogRoute}{/*path}.md`,
  `${blogContentRoute}{/*path}/content.md`,
);

const locales = new Set<string>(i18n.languages);

// "/zh/docs/x" -> { locale: "zh", path: "/docs/x" }
function splitLocale(pathname: string): { locale?: string; path: string } {
  const [first, ...rest] = pathname.slice(1).split('/');
  if (locales.has(first)) {
    const path = `/${rest.join('/')}`;
    return { locale: first, path: path === '/' ? '/' : path };
  }
  return { path: pathname };
}

// Route handlers that live outside the /[lang] segment and must not be
// locale-rewritten by the i18n middleware.
function isNonLocalized(pathname: string) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/llms.txt' ||
    pathname === '/llms-full.txt'
  );
}

export default function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const { locale, path } = splitLocale(pathname);

  // The markdown content routes live under /[lang], so a rewritten target
  // always carries an explicit locale segment.
  const toContent = (target: string, vary?: boolean) =>
    NextResponse.rewrite(
      new URL(`/${locale ?? i18n.defaultLanguage}${target}`, request.nextUrl),
      vary ? { headers: { Vary: 'Accept' } } : undefined,
    );

  // /docs/x.md (and /zh/docs/x.md, /blog/x.md) -> raw markdown content
  const suffix = rewriteDocsSuffix(path) || rewriteBlogSuffix(path);
  if (suffix) return toContent(suffix);

  // Accept: text/markdown -> same content, URL unchanged
  if (isMarkdownPreferred(request)) {
    const target = rewriteDocs(path) || rewriteBlog(path);
    if (target) return toContent(target, true);
  }

  // i18n routing, equivalent to fumadocs' createI18nMiddleware with
  // `hideLocale: 'default-locale'` but safe against re-invocation: the node
  // server runs this proxy again on rewritten URLs, so the "redirect
  // /en/... -> /..." canonicalization from createI18nMiddleware would
  // conflict with the rewrite it just issued (observed as a 307 loop).
  if (locale) {
    // Explicit /zh/... or /en/... -> the [lang] segment handles it.
    return NextResponse.next();
  }

  if (isNonLocalized(pathname)) {
    return NextResponse.next();
  }

  // No locale prefix -> render as the default locale while keeping the
  // visible URL unprefixed (e.g. /docs/steering renders [lang]=en).
  // "/" must rewrite to "/en", not "/en/", or the trailing-slash
  // normalization answers with a redirect.
  return NextResponse.rewrite(
    new URL(
      `/${i18n.defaultLanguage}${pathname === '/' ? '' : pathname}`,
      request.nextUrl,
    ),
  );
}

export const config = {
  matcher: ['/((?!_next).*)'],
};
