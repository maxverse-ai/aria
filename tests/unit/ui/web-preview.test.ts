import { describe, expect, it } from 'vitest';

import {
  previewApiRequestDecision,
  rewritePreviewApiPath,
  webPreviewConfig,
  WEB_PREVIEW_API_MODE_ENV,
  WEB_PREVIEW_API_TARGET_ENV,
  WEB_PREVIEW_BASE_ENV,
  WEB_PREVIEW_PORT_ENV,
  WEB_PREVIEW_PUBLIC_ORIGIN_ENV,
  WEB_PREVIEW_WRITE_CONFIRM_ENV,
} from '../../../web/preview-config';
import {
  rewritePreviewStylexPath,
  rewritePreviewStylexRuntime,
} from '../../../web/vite.config';

describe('web console preview configuration', () => {
  it('maps the base-prefixed Astryx stylesheet back to its dev endpoint', () => {
    expect(rewritePreviewStylexPath('/aria-dev/virtual:stylex.css', '/aria-dev/'))
      .toBe('/virtual:stylex.css');
    expect(rewritePreviewStylexPath('/aria-dev/virtual:stylex.css?t=42', '/aria-dev/'))
      .toBe('/virtual:stylex.css?t=42');
    expect(rewritePreviewStylexPath('/aria-dev/src/main.tsx', '/aria-dev/'))
      .toBe('/aria-dev/src/main.tsx');
  });

  it('mounts the StyleX runtime refresh below the preview base', () => {
    const runtime = [
      "const DEV_CSS_PATH = '/virtual:stylex.css';",
      "fetch(DEV_CSS_PATH + '?t=' + Date.now());",
    ].join('\n');

    expect(rewritePreviewStylexRuntime(runtime, '/aria-dev/')).toContain(
      "const DEV_CSS_PATH = '/aria-dev/virtual:stylex.css';",
    );
  });

  it('defaults to an isolated read-only preview with no API target', () => {
    expect(webPreviewConfig({})).toEqual({
      base: '/aria-dev/',
      port: 5174,
      apiPrefix: '/aria-dev/api',
      apiMode: 'read-only',
    });
  });

  it('accepts a loopback API and exact public origin', () => {
    expect(webPreviewConfig({
      [WEB_PREVIEW_BASE_ENV]: '/console-preview/',
      [WEB_PREVIEW_PORT_ENV]: '5275',
      [WEB_PREVIEW_API_TARGET_ENV]: 'http://127.0.0.1:5274',
      [WEB_PREVIEW_PUBLIC_ORIGIN_ENV]: 'https://console.example.com',
    })).toEqual({
      base: '/console-preview/',
      port: 5275,
      apiPrefix: '/console-preview/api',
      apiTarget: 'http://127.0.0.1:5274',
      apiMode: 'read-only',
      publicOrigin: 'https://console.example.com',
    });
  });

  it('rewrites only the mounted preview API path', () => {
    const config = webPreviewConfig({ [WEB_PREVIEW_BASE_ENV]: '/aria-dev/' });
    expect(rewritePreviewApiPath('/aria-dev/api/status?profile=aria', config))
      .toBe('/api/status?profile=aria');
    expect(rewritePreviewApiPath('/aria-dev/assets/app.js', config))
      .toBe('/aria-dev/assets/app.js');
  });

  it('fails closed without a backend and allows only reads by default', () => {
    expect(previewApiRequestDecision('GET', { apiMode: 'read-only' }))
      .toBe('unconfigured');
    expect(previewApiRequestDecision('POST', {
      apiMode: 'read-only',
      apiTarget: 'http://127.0.0.1:5274',
    })).toBe('method-not-allowed');
    expect(previewApiRequestDecision('HEAD', {
      apiMode: 'read-only',
      apiTarget: 'http://127.0.0.1:5274',
    })).toBe('proxy');
  });

  it('rejects remote targets and malformed mounts', () => {
    expect(() => webPreviewConfig({ [WEB_PREVIEW_API_TARGET_ENV]: 'https://example.com' }))
      .toThrow(WEB_PREVIEW_API_TARGET_ENV);
    expect(() => webPreviewConfig({ [WEB_PREVIEW_BASE_ENV]: '/nested/preview/' }))
      .toThrow(WEB_PREVIEW_BASE_ENV);
    expect(() => webPreviewConfig({ [WEB_PREVIEW_PORT_ENV]: '0' }))
      .toThrow(WEB_PREVIEW_PORT_ENV);
  });

  it('requires an explicit isolated-backend confirmation before enabling writes', () => {
    expect(() => webPreviewConfig({ [WEB_PREVIEW_API_MODE_ENV]: 'write' }))
      .toThrow(WEB_PREVIEW_WRITE_CONFIRM_ENV);
    expect(webPreviewConfig({
      [WEB_PREVIEW_API_MODE_ENV]: 'write',
      [WEB_PREVIEW_WRITE_CONFIRM_ENV]: 'isolated-development-backend',
    }).apiMode).toBe('write');
  });
});
