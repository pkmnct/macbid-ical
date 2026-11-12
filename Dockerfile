# syntax=docker/dockerfile:1

# Build on the builder's own architecture: there are no native modules, so the
# compiled output and node_modules are the same for every target platform.
FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json *.ts ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

# An empty directory to copy in as the default, writable data directory
RUN mkdir /data

# Distroless: Node and its runtime libraries only. No shell, no package manager,
# no npm, no openssl. The :nonroot tag runs as uid 65532. Keep the Node major
# version in step with the build stage above.
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /usr/src/macbid-ical
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/*.js ./
# Tokens (and any TLS certificate) live here: mount a volume to keep them
COPY --from=build --chown=65532:65532 /data ./data

EXPOSE 3000 3443

# The base image's entrypoint is node
CMD ["index.js"]
