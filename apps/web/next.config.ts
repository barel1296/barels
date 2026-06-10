import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // API proxying happens at runtime via src/app/api/v1/[...path]/route.ts
  // (reads API_INTERNAL_URL per request — no build-time coupling).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
              "connect-src 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
