/**
 * Plain JavaScript, not TypeScript, on purpose.
 *
 * Next transpiles a `.ts` config at startup, which means `next start` needs the
 * TypeScript compiler present at *run* time. TypeScript is a devDependency, so
 * the packaged desktop app does not have it — and Next's fallback is to run
 * `npm install typescript` into the installed application directory, which
 * fails and takes the server with it. The config is a dozen lines; typing it
 * with JSDoc costs nothing and keeps the runtime dependency-free.
 *
 * @type {import("next").NextConfig}
 */
const nextConfig = {
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
