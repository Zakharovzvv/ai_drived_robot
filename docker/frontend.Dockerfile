# syntax=docker/dockerfile:1.6
FROM node:20-bullseye-slim AS build

ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app/frontend/web

COPY frontend/web/pnpm-lock.yaml frontend/web/package.json ./
RUN pnpm install --frozen-lockfile

COPY frontend/web/ ./
RUN pnpm run build

FROM nginx:1.27-alpine

COPY docker/frontend.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
