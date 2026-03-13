# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS api-deps
WORKDIR /app/server

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS frontend-deps
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

FROM frontend-deps AS frontend-build
WORKDIR /app

COPY . /app

WORKDIR /app/frontend
RUN npm run build:hf

FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache nginx git git-lfs

COPY --from=api-deps /app/server/node_modules /app/server/node_modules
COPY server /app/server
COPY frontend/nginx.huggingface.conf.template /app/frontend/nginx.huggingface.conf.template
COPY scripts/start-hf-space.sh /usr/local/bin/start-hf-space.sh
COPY --from=frontend-build /app/frontend/dist/ /usr/share/nginx/html/

RUN sed -i 's/\r$//' /usr/local/bin/start-hf-space.sh /app/frontend/nginx.huggingface.conf.template \
  && chmod +x /usr/local/bin/start-hf-space.sh \
  && mkdir -p /data/chunks /run/nginx /var/lib/nginx/tmp /var/log/nginx

ENV NODE_ENV=production
ENV PORT=8787
ENV APP_PORT=7860
ENV DATA_DIR=/data
ENV DB_PATH=/data/k-vault.db
ENV CHUNK_DIR=/data/chunks

EXPOSE 7860

CMD ["/usr/local/bin/start-hf-space.sh"]
