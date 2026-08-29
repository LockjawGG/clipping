import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Lint runs as its own CI step, not folded into `next build`.
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Trade a little build time for a much lower memory ceiling on the webpack
    // path (`next build`, `npm run dev:webpack`). The default `dev` script uses
    // Turbopack and is unaffected by this flag.
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
