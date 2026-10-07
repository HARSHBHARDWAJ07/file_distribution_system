/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Every page is client-rendered against the gateway, so the site exports
  // to plain files and deploys as a free Render Static Site: CDN-served, no
  // server to sleep. trailingSlash emits files/index.html, so /files/ resolves
  // without host-specific rewrite rules.
  output: 'export',
  trailingSlash: true,
};

export default nextConfig;
