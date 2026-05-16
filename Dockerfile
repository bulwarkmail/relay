FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PUSH_DATA_DIR=/app/data
ENV PORT=3003

RUN addgroup -S relay && adduser -S relay -G relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R relay:relay /app

USER relay
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3003/api/health || exit 1
CMD ["node", "dist/server.js"]
