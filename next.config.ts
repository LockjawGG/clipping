import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Lint runs as its own CI step, not folded into `next build`.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
