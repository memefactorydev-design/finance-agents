/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ["imapflow", "mailparser", "nodemailer", "pg", "unpdf"] },
  images: { unoptimized: true },
};
export default nextConfig;
