import { describe, expect, it } from 'vitest';
import {
  extractWechatKfMarkdownImages,
  renderWechatKfPlainText,
} from '../../../src/channel/wechat-kf/plain-text-renderer';

describe('renderWechatKfPlainText', () => {
  it('keeps ordinary text readable and normalizes outer whitespace', () => {
    expect(renderWechatKfPlainText('  DemoBox S3 支持 HDR。\n')).toBe('DemoBox S3 支持 HDR。');
    expect(renderWechatKfPlainText('')).toBe('');
  });

  it('renders headings, emphasis, quotes, and rules without markdown markers', () => {
    expect(renderWechatKfPlainText([
      '## HDR 支持情况',
      '',
      '> **S3 5.2** 支持 *HDR*。',
      '',
      '---',
      '',
      '~~旧说明~~',
    ].join('\n'))).toBe([
      'HDR 支持情况',
      '',
      'S3 5.2 支持 HDR。',
      '',
      '旧说明',
    ].join('\n'));
  });

  it('renders ordered, unordered, nested, and task lists', () => {
    expect(renderWechatKfPlainText([
      '- S3',
      '  - **5.2**',
      '  - [x] HDR',
      '1. 准备设备',
      '2. 开启输出',
    ].join('\n'))).toBe([
      '• S3',
      '  • 5.2',
      '  • ☑ HDR',
      '',
      '1. 准备设备',
      '2. 开启输出',
    ].join('\n'));
  });

  it('preserves code content while removing code markup and language labels', () => {
    expect(renderWechatKfPlainText([
      '运行 `status --format=json`。',
      '',
      '```bash',
      '# literal comment',
      'value="**literal**"',
      '```',
    ].join('\n'))).toBe([
      '运行 status --format=json。',
      '',
      '# literal comment',
      'value="**literal**"',
    ].join('\n'));
  });

  it('renders links, autolinks, and images as plain text', () => {
    expect(renderWechatKfPlainText([
      '[查看说明](https://example.com/docs)',
      '<https://example.com/status>',
      '![接口图](https://example.com/image.png)',
    ].join('\n'))).toBe([
      '查看说明：https://example.com/docs',
      'https://example.com/status',
      '图片：接口图（https://example.com/image.png）',
    ].join('\n'));
  });

  it('does not expose local image paths in plain-text fallbacks', () => {
    expect(renderWechatKfPlainText([
      '![产品图](/data/external-product/workspace/kb/assets/product.png)',
      '![受控图](kb-asset://external/product.png)',
    ].join('\n'))).toBe([
      '图片：产品图',
      '图片：受控图',
    ].join('\n'));
  });

  it('extracts nested markdown image syntax without authorizing its href', () => {
    expect(extractWechatKfMarkdownImages([
      '- ![产品图](/data/external-product/workspace/kb/assets/product.png)',
      '',
      '| 预览 |',
      '| --- |',
      '| ![表格图](https://example.com/table.png) |',
    ].join('\n'))).toEqual([
      {
        raw: '![产品图](/data/external-product/workspace/kb/assets/product.png)',
        text: '产品图',
        href: '/data/external-product/workspace/kb/assets/product.png',
      },
      {
        raw: '![表格图](https://example.com/table.png)',
        text: '表格图',
        href: 'https://example.com/table.png',
      },
    ]);
  });

  it('renders tables without markdown separators', () => {
    expect(renderWechatKfPlainText([
      '| 型号 | HDR |',
      '| --- | --- |',
      '| **S3** | 支持 |',
    ].join('\n'))).toBe([
      '型号 ｜ HDR',
      'S3 ｜ 支持',
    ].join('\n'));
  });

  it('keeps visible HTML text without executing or exposing tags', () => {
    expect(renderWechatKfPlainText([
      '<div>DemoBox <b>S3</b></div>',
      '<script>alert("secret")</script>',
      'Tom &amp; Jerry &#x1F642;',
    ].join('\n'))).toBe([
      'DemoBox S3',
      '',
      'Tom & Jerry 🙂',
    ].join('\n'));
  });

  it('is idempotent for its own rendered output', () => {
    const once = renderWechatKfPlainText('## 标题\n\n- **结论**：支持');
    expect(renderWechatKfPlainText(once)).toBe(once);
  });
});
