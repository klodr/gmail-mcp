# syntax=docker/dockerfile:1.7
#
# Multi-stage image for the stdio MCP server. The build stage runs
# `npm run build` (which in turn runs `tsc --noEmit && tsup`); the
# runtime stage keeps only the bundled dist/, pruned node_modules,
# and package.json.
#
# OAuth flow note: the first-run `auth` command starts a local HTTP
# server on a loopback port to receive the OAuth callback. That port
# must be reachable from the user's browser. In a container, the
# recommended flow is:
#   1. Run `npx @klodr/gmail-mcp auth` ON THE HOST first, to generate
#      ~/.gmail-mcp/credentials.json outside the container.
#   2. Mount ~/.gmail-mcp as a read-only volume into the container.
# The container then reuses the refresh token without ever listening
# on a port itself.
#
# Version is a build-arg so the release workflow can pass the
# package.json version without the Dockerfile hard-coding anything.

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev


FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime

ARG VERSION=0.0.0

LABEL org.opencontainers.image.source="https://github.com/klodr/gmail-mcp"
LABEL org.opencontainers.image.url="https://github.com/klodr/gmail-mcp"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="@klodr/gmail-mcp"
LABEL org.opencontainers.image.description="Gmail MCP server — scope-gated tools + attachment/download path jails + supply-chain hardening."

# Drop root — the stdio MCP process does not need any capabilities.
RUN addgroup -S mcp && adduser -S -G mcp mcp
USER mcp

WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --from=build --chown=mcp:mcp /app/package.json ./package.json
COPY --chown=mcp:mcp LICENSE ./LICENSE

# Pre-create the mount-point for the host-provided credentials.
# The user is expected to mount ~/.gmail-mcp here:
#   docker run -v ~/.gmail-mcp:/home/mcp/.gmail-mcp:ro ...
RUN mkdir -p /home/mcp/.gmail-mcp && chmod 700 /home/mcp/.gmail-mcp
ENV GMAIL_OAUTH_PATH=/home/mcp/.gmail-mcp/gcp-oauth.keys.json
ENV GMAIL_CREDENTIALS_PATH=/home/mcp/.gmail-mcp/credentials.json
ENV GMAIL_MCP_ATTACHMENT_DIR=/home/mcp/GmailAttachments
ENV GMAIL_MCP_DOWNLOAD_DIR=/home/mcp/GmailDownloads
RUN mkdir -p /home/mcp/GmailAttachments /home/mcp/GmailDownloads \
    && chmod 700 /home/mcp/GmailAttachments /home/mcp/GmailDownloads

# stdio MCP: no listening sockets, no EXPOSE. HEALTHCHECK is meaningless
# for a stdio child process — make that explicit so scanners (Checkov
# CKV_DOCKER_2 etc.) stop flagging it as a missing-probe finding.
HEALTHCHECK NONE
ENTRYPOINT ["node", "dist/index.js"]
