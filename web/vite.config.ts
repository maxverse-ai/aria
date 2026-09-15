import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {astryxStylex} from '@astryxdesign/build/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  previewApiRequestDecision,
  rewritePreviewApiPath,
  webPreviewConfig,
  type WebPreviewConfig,
} from './preview-config';

// Builds the management console into ONE self-contained index.html (JS+CSS+
// icons inlined) written to ../src/ui/generated/, which tsup then inlines into
// the CLI bundle as a string — the bridge serves it with zero runtime file/CDN
// deps (works offline).
export default defineConfig(({ command }) => {
  const preview = command === 'serve' ? webPreviewConfig() : undefined;
  return {
    base: preview?.base ?? '/',
    plugins: [
      ...astryxStylex(),
      react(),
      ...(command === 'build' ? [viteSingleFile()] : []),
      ...(preview ? [
        previewStylexBasePathFix(preview),
        previewStylexRuntimeBasePathFix(preview),
        previewApiGuard(preview),
      ] : []),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    ...(preview ? { server: previewServer(preview) } : {}),
    build: {
      outDir: fileURLToPath(new URL('../src/ui/generated', import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4096,
    },
  };
});

const STYLEX_DEV_CSS_PATH = '/virtual:stylex.css';
const STYLEX_DEV_RUNTIME_ID = 'virtual:stylex:runtime';
const STYLEX_DEV_RUNTIME_CSS_DECLARATION = `const DEV_CSS_PATH = '${STYLEX_DEV_CSS_PATH}';`;

export function rewritePreviewStylexPath(requestUrl: string, previewBase: string): string {
  const previewStylexPath = `${previewBase}virtual:stylex.css`;
  if (requestUrl === previewStylexPath || requestUrl.startsWith(`${previewStylexPath}?`)) {
    return `${STYLEX_DEV_CSS_PATH}${requestUrl.slice(previewStylexPath.length)}`;
  }
  return requestUrl;
}

export function rewritePreviewStylexRuntime(code: string, previewBase: string): string {
  return code.replace(
    STYLEX_DEV_RUNTIME_CSS_DECLARATION,
    `const DEV_CSS_PATH = '${previewBase}virtual:stylex.css';`,
  );
}

/**
 * Astryx serves its dev stylesheet from an absolute Vite endpoint. Vite adds
 * the configured base to the link in index.html, so previews mounted below a
 * path need to translate that one request back before Astryx handles it.
 */
function previewStylexBasePathFix(preview: WebPreviewConfig): Plugin {
  return {
    name: 'aria-web-preview-stylex-base-path',
    enforce: 'post',
    configureServer(server) {
      return () => {
        server.middlewares.stack.unshift({
          route: '',
          handle: (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
            if (req.url) {
              req.url = rewritePreviewStylexPath(req.url, preview.base);
            }
            next();
          },
        });
      };
    },
  };
}

/**
 * StyleX's dev runtime refreshes its generated stylesheet after modules are
 * transformed, but its fetch URL is absolute. Point that refresh at the
 * mounted preview path so a cold page load receives the complete rule set.
 */
function previewStylexRuntimeBasePathFix(preview: WebPreviewConfig): Plugin {
  return {
    name: 'aria-web-preview-stylex-runtime-base-path',
    enforce: 'post',
    transform(code, id) {
      if (!id.includes(STYLEX_DEV_RUNTIME_ID)) {
        return;
      }
      return {
        code: rewritePreviewStylexRuntime(code, preview.base),
        map: null,
      };
    },
  };
}

function previewServer(preview: WebPreviewConfig) {
  const publicOrigin = preview.publicOrigin ? new URL(preview.publicOrigin) : undefined;
  return {
    host: '127.0.0.1',
    port: preview.port,
    strictPort: true,
    ...(publicOrigin ? { allowedHosts: [publicOrigin.hostname] } : {}),
    ...(publicOrigin ? {
      hmr: {
        protocol: publicOrigin.protocol === 'https:' ? 'wss' as const : 'ws' as const,
        host: publicOrigin.hostname,
        clientPort: publicOrigin.port
          ? Number(publicOrigin.port)
          : publicOrigin.protocol === 'https:' ? 443 : 80,
      },
    } : {}),
    ...(preview.apiTarget ? {
      proxy: {
        [preview.apiPrefix]: {
          target: preview.apiTarget,
          changeOrigin: true,
          rewrite: (path: string) => rewritePreviewApiPath(path, preview),
        },
      },
    } : {}),
  };
}

function previewApiGuard(preview: WebPreviewConfig): Plugin {
  return {
    name: 'aria-web-preview-api-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path !== preview.apiPrefix && !path.startsWith(`${preview.apiPrefix}/`)) {
          next();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const decision = previewApiRequestDecision(req.method ?? 'GET', preview);
        if (decision === 'unconfigured') {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'preview API target is not configured' }));
          return;
        }
        if (decision === 'method-not-allowed') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end(JSON.stringify({ error: 'preview API is read-only' }));
          return;
        }
        next();
      });
    },
  };
}
