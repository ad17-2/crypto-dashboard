import type { NextConfig } from 'next';

/**
 * Express API origin. apps/web fetches the dashboard payload server-side from this origin, and
 * also rewrites incoming /api/* and /health requests here so the PUBLIC URL CONTRACT existing
 * clients depend on (curl /api/dashboard, curl /health against the public origin) keeps working
 * once apps/web — not the old Python http.server — is the thing answering the public port.
 */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_BASE_URL}/api/:path*` },
      { source: '/health', destination: `${API_BASE_URL}/health` },
    ];
  },
};

export default nextConfig;
