FROM --platform=$BUILDPLATFORM node:22-bookworm AS backend-builder

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
COPY backend/.npmrc .npmrc
COPY backend/prisma ./prisma

RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

COPY backend/. .

RUN DATABASE_URL=not_required npx prisma generate --schema=prisma/schema.prisma
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-bookworm AS frontend-builder

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/. .

ARG VITE_E2E_TESTING=false
RUN VITE_E2E_TESTING=$VITE_E2E_TESTING npm run build

FROM node:22-bookworm-slim

# Install runtime packages from current Debian security repositories instead of
# inheriting Chromium and shared libraries frozen in the external server image.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        dumb-init \
        fonts-freefont-ttf \
        netcat-traditional \
        nginx \
        openssl \
    && rm -rf /var/lib/apt/lists/*

# Debian's nginx package enables a default site in addition to conf.d files.
RUN rm -f /etc/nginx/sites-enabled/default

WORKDIR /usr/share/nginx
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

ENV PLUGIN_DIR=/usr/share/nginx/plugins
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=frontend-builder /app/dist /usr/share/nginx/html

COPY --from=backend-builder /app/dist /usr/share/nginx/backend
COPY --from=backend-builder /app/node_modules /usr/share/nginx/backend/node_modules
COPY --from=backend-builder /app/package*.json /usr/share/nginx/backend/
COPY --from=backend-builder /app/prisma /usr/share/nginx/backend/prisma
COPY --from=backend-builder /app/package.json /usr/share/nginx/
COPY --from=backend-builder /app/prisma.config.ts /usr/share/nginx/backend
COPY --from=backend-builder /app/prisma.config.ts /usr/share/nginx/backend/prisma
COPY --from=backend-builder /app/prisma.config.ts /usr/share/nginx/backend/src

COPY entrypoint.sh /usr/share/nginx/entrypoint.sh
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

RUN chmod +x /usr/share/nginx/entrypoint.sh

ENV BETTER_AUTH_URL="http://localhost:3000"

CMD ["/usr/share/nginx/entrypoint.sh"]
