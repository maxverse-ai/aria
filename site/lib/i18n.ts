import { defineI18nUI } from 'fumadocs-ui/i18n';

// English is the default locale and stays unprefixed (/docs/...); Chinese
// lives under /zh/... Missing translations fall back to English content.
export const i18n = defineI18nUI(
  {
    defaultLanguage: 'en',
    languages: ['en', 'zh'],
    hideLocale: 'default-locale',
    fallbackLanguage: 'en',
  },
  {
    en: { displayName: 'English' },
    zh: {
      displayName: '中文',
      'Search(search dialog)': '搜索',
      'Search(search trigger)': '搜索',
      'No results found(search dialog)': '没有找到结果',
      'On this page(table of contents)': '本页目录',
      'Table of Contents(inline table of contents)': '目录',
      'No Headings(table of contents)': '无标题',
      'Next Page(pagination)': '下一页',
      'Previous Page(pagination)': '上一页',
      'Choose a language(language switcher)': '选择语言',
      'Copy Markdown(page actions)': '复制 Markdown',
      'View as Markdown(page actions)': '查看 Markdown',
      'Edit on GitHub(edit page)': '在 GitHub 上编辑',
      'Open(page actions)': '打开',
      'Open in GitHub(page actions)': '在 GitHub 中打开',
      'Page Not Found(404 not found page)': '页面未找到',
      'Back to Home(404 not found page)': '返回首页',
      'Last updated on(page footer)': '最后更新于',
      'Copied Text(code block)(aria-label)': '已复制',
      'Copy Text(code block)(aria-label)': '复制',
      'Toggle Theme(theme switcher)(aria-label)': '切换主题',
      'Dark(theme switcher)(aria-label)': '深色',
      'Light(theme switcher)(aria-label)': '浅色',
      'System(theme switcher)(aria-label)': '系统',
    },
  },
);
