import { describe, expect, it } from 'vitest';
import { parseLarkCliArguments, providerLarkCliArguments } from '../../../src/lark-cli/argument-policy';

describe('Lark command boundary', () => {
  it.each([
    ['docs', '+media-download', '--as', 'bot', '--type', 'whiteboard', '--token', 'board-id', '--output', 'board.png'],
    ['drive', '+export', '--as=bot', '--token=doc-id', '--doc-type', 'docx', '--file-extension', 'docx'],
    ['drive', '+comment-list', '--token', 'file-id'],
    ['apps', '+get', '--app-id', 'miaoda-app-id'],
    ['apps', '+db-sync-create', '--app-id', 'miaoda-app-id', '--config', '{"token":"business-field","profile":"business-field"}'],
    ['im', '+send', '--content', '{"text":"--profile --as --token"}'],
    ['event', 'consume', 'im.message.receive_v1', '-p', 'chat_id=chat', '--max-events', '1'],
    ['api', 'POST', '/open-apis/example/v1/items', '--data', '{"app_id":"business-resource"}'],
  ])('passes a business call without credential-keyword false positives: %s %s', (...argv) => {
    const parsed = parseLarkCliArguments(argv);
    expect(parsed.kind).toBe('business');
    const outgoing = providerLarkCliArguments(parsed.argv, 'bot');
    expect(outgoing.argv.slice(-2)).toEqual(['--as', 'bot']);
    expect(outgoing.argv.filter(arg => arg === '--as')).toHaveLength(1);
  });

  it.each(['token', 'config', 'app-id', 'source', 'identity', 'host', 'tenant', 'base-url', 'new-business-option'])('does not guess credential ownership from --%s', name => {
    expect(providerLarkCliArguments(['docs', '+future-shortcut', `--${name}=business-value`], 'bot').kind).toBe('business');
  });

  it.each([
    [[], ['--help']],
    [['--help'], ['--help']],
    [['-h'], ['--help']],
    [['--version'], ['--version']],
    [['drive'], ['help', 'drive']],
    [['drive', 'files', '--help'], ['help', 'drive', 'files']],
    [['drive', '+upload', '--help'], ['help', 'drive', '+upload']],
    [['auth', 'login', '--help'], ['help', 'auth', 'login']],
    [['help', 'config', 'bind'], ['help', 'config', 'bind']],
    [['skills', 'list'], ['skills', 'list']],
    [['skills', 'read', 'lark-doc/references/lark-doc-md.md'], ['skills', 'read', 'lark-doc/references/lark-doc-md.md']],
    [['schema', 'drive.files.list'], ['schema', 'drive.files.list']],
    [['event', 'list'], ['event', 'list']],
    [['event', 'schema', 'im.message.receive_v1'], ['event', 'schema', 'im.message.receive_v1']],
  ])('keeps discovery commands free of business identity flags: %j', (argv, expected) => {
    expect(providerLarkCliArguments(argv, 'bot')).toMatchObject({ kind: 'inspection', argv: expected });
  });

  it('preserves option-looking payloads across ingress and provider validation', () => {
    const ingress = parseLarkCliArguments(['im', '+send', '--as', 'user', '--content', '--profile', '--title', '--as', '--text=--help']);
    expect(ingress.identity).toBe('user');
    expect(providerLarkCliArguments(ingress.argv, 'user').argv).toEqual([
      'im', '+send', '--content=--profile', '--title=--as', '--text=--help', '--as', 'user',
    ]);
  });

  it('cannot disable host identity selection with an end-of-options marker', () => {
    const ingress = parseLarkCliArguments(['--as', 'bot', 'docs', '+fetch', '--', '--as', 'user', '--profile=other']);
    expect(ingress.identity).toBe('bot');
    expect(providerLarkCliArguments(ingress.argv, 'bot').argv).toEqual([
      'docs', '+fetch', '--as', 'bot', '--', '--as', 'user', '--profile=other',
    ]);
    expect(providerLarkCliArguments(['im', '+send', '--text', '--'], 'bot').argv).toEqual([
      'im', '+send', '--text=--', '--as', 'bot',
    ]);
  });

  it.each([
    ['config', 'bind'], ['profile', 'use', 'other'], ['update'], ['login'], ['logout'],
    ['--json', 'profile', 'use', 'other'],
    ['--profile', 'other', 'docs', '+fetch'],
    ['docs', '+fetch', '--profile=other'],
    ['docs', '+fetch', '--as=user'],
    ['auth', 'login', '--no-wait'],
  ])('keeps actual configuration and credential management owned: %j', (...argv) => {
    expect(() => providerLarkCliArguments(argv, 'bot')).toThrow('management operation');
    expect(() => providerLarkCliArguments(argv, 'bot')).toThrow('Rejected locally before a Feishu request');
  });

  it('rejects ambiguous identity requests without echoing caller values', () => {
    for (const argv of [
      ['docs', '+fetch', '--as', 'bot', '--as=user'], ['docs', '+fetch', '--as=private-credential'],
    ]) {
      expect(() => parseLarkCliArguments(argv)).toThrow('[lark-cli:invalid-arguments]');
      try { parseLarkCliArguments(argv); } catch (error) { expect(String(error)).not.toContain('private-credential'); }
    }
  });
});
