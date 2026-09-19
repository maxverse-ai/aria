import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, blogRoute, docsRoute, gitConfig } from './shared';

export function baseOptions(lang = 'en'): BaseLayoutProps {
  const prefix = lang === 'en' ? '' : `/${lang}`;
  const t =
    lang === 'zh'
      ? { docs: '文档', blog: '更新日志' }
      : { docs: 'Docs', blog: 'Changelog' };

  return {
    nav: {
      title: appName,
      transparentMode: 'top',
    },
    links: [
      {
        text: t.docs,
        url: `${prefix}${docsRoute}`,
        active: 'nested-url',
      },
      {
        text: t.blog,
        url: `${prefix}${blogRoute}`,
        active: 'nested-url',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    // The site pins a dark default with no system mode, so the switcher is a
    // simple light/dark toggle rather than a three-way dropdown.
    themeSwitch: { mode: 'light-dark' },
  };
}
