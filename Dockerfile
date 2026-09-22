FROM node:22-slim AS build

WORKDIR /app
COPY package*.json ./
# better-sqlite3 ships a binding.gyp, and npm compiles any package that
# has one — even this one, which also ships a prebuilt binary for every
# platform it supports and loads that instead. The compile is therefore
# pure waste: it needs python3 and a toolchain, takes minutes on a
# Raspberry Pi, and produces a file the module never opens. Skipping
# install scripts is safe here because in this dependency tree only
# esbuild and fsevents declare one, and neither is needed to run `tsc`.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm run openapi

FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.json ./openapi.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
