import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  experimental: {
    // middleware.ts runs on every request, and Next.js cuts request bodies
    // passing through it at 10 MB — an exported bookmark file can be larger
    proxyClientMaxBodySize: '100mb',
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.twimg.com',
      },
    ],
  },
}

export default nextConfig
