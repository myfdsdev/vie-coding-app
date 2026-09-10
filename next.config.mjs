/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server-only packages with native/optional deps (dockerode -> ssh2 -> cpu-features)
    // must be required at runtime, not bundled by webpack.
    serverComponentsExternalPackages: [
      'dockerode',
      'docker-modem',
      'ssh2',
      'cpu-features',
      'tar-stream',
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
