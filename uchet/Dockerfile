# Production image from prebuilt Next.js standalone (build on host first).
# Host: cd uchet && npm install --legacy-peer-deps && npm run build && npx prisma db push
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/app/data/custom.db"
ENV UCHET_DATA_DIR=/app/data
ENV UCHET_DB_TEMPLATE=/app/db-template/custom.db

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data /app/data/groups /app/logs /app/db-template

COPY .next/standalone ./
COPY .next/static ./.next/static
COPY public ./public
COPY db-template ./db-template
COPY scripts/migrate-db.mjs ./scripts/migrate-db.mjs

# Prisma engines (may already be in standalone; copy if present on host build)
COPY node_modules/@prisma/client ./node_modules/@prisma/client
COPY node_modules/.prisma ./node_modules/.prisma

RUN chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000

CMD ["sh", "-c", "mkdir -p /app/data/groups; if [ ! -f /app/data/custom.db ] || [ ! -s /app/data/custom.db ]; then cp /app/db-template/custom.db /app/data/custom.db; fi; node scripts/migrate-db.mjs || true; node server.js"]
