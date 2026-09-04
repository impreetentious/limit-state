import type { NextConfig } from 'next';

// Static export: the product ships as files, with no server runtime to trust.

/**
 * Fully static export — no server, no SSR, everything client-side by design.
 *
 * BASE_PATH handles subpath hosting:
 *   GitHub Pages project site: BASE_PATH=/limit-state  (set in .github/workflows/ci.yml)
 *   GitLab Pages project site: BASE_PATH=/$CI_PROJECT_NAME  (set in .gitlab-ci.yml)
 *   Custom domain / root deploys: leave unset.
 * Shareable state lives in the URL hash, which is basePath-agnostic.
 */
const basePath = process.env.BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
  // three/addons (OrbitControls) ships as ESM that Next must transpile. docs/FEM-SPEC.md §14 Phase 3.
  transpilePackages: ['three'],
};

export default nextConfig;
