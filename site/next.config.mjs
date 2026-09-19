import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: 'standalone',
  redirects: async () => [
    // The former /blog collection was renamed to /changelog — it holds release
    // notes, not blog posts. Keep the old paths permanently redirected.
    { source: '/blog/:path*', destination: '/changelog/:path*', permanent: true },
    { source: '/en/blog/:path*', destination: '/en/changelog/:path*', permanent: true },
    { source: '/zh/blog/:path*', destination: '/zh/changelog/:path*', permanent: true },
    { source: '/llms.mdx/blog/:path*', destination: '/llms.mdx/changelog/:path*', permanent: true },
    { source: '/en/llms.mdx/blog/:path*', destination: '/en/llms.mdx/changelog/:path*', permanent: true },
    { source: '/zh/llms.mdx/blog/:path*', destination: '/zh/llms.mdx/changelog/:path*', permanent: true },
  ],
};

export default withMDX(config);
