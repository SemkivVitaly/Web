import type { NextConfig } from "next";

/** В LAN/Docker iframe чата может быть с любого хоста — разрешаем встраивание. */
function frameAncestors(): string {
  const extra = (process.env.FRAME_ANCESTORS || process.env.CHAT_PUBLIC_URL || process.env.CHAT_URL || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const hosts = new Set<string>(["'self'", "*", ...extra])
  for (const part of [...hosts]) {
    if (part === "*" || part === "'self'") continue
    try {
      const u = new URL(part)
      hosts.add(`${u.protocol}//${u.host}`)
      hosts.delete(part)
    } catch {
      /* keep as-is */
    }
  }
  // * уже покрывает всё; оставляем явный список + * для совместимости
  return `frame-ancestors ${[...hosts].join(" ")}`
}

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  // Monorepo: не поднимать root до LocalChat (иначе ломается Turbopack/пути)
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/((?!_next/static).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: frameAncestors() },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
