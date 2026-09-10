/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A second local instance (e.g. PORT=3001) needs its own build folder;
  // two dev servers writing one .next folder corrupt each other.
  distDir: process.env.FORGE_NEXT_DIST_DIR || '.next',
  experimental: {
    // Server-only packages with native/optional deps (dockerode -> ssh2 -> cpu-features,
    // better-sqlite3) must be required at runtime, not bundled by webpack.
    serverComponentsExternalPackages: [
      'dockerode',
      'docker-modem',
      'ssh2',
      'cpu-features',
      'tar-stream',
      'better-sqlite3',
      'simple-git',
      '@anthropic-ai/sdk',
      '@google/genai',
    ],
  },
  webpack(config) {
    // workspaces/ changes on every agent turn; never let Next watch or rebuild on it.
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/node_modules/**', '**/.git/**', '**/workspaces/**', '**/docker/**'],
    };
    return config;
  },
};

export default nextConfig;
