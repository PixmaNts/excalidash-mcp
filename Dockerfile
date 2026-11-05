# excalidash-mcp in HTTP mode, for a shared deployment where every request carries the
# caller's ExcaliDash API key (see "Shared server over HTTP" in the README).
#
# The Playwright image ships Node and the Chromium build matching the pinned playwright
# dependency; keep its tag equal to the version in package.json.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY dist ./dist
COPY skills ./skills

ENV NODE_ENV=production \
    EXCALIDASH_MCP_TRANSPORT=http \
    EXCALIDASH_MCP_HOST=0.0.0.0 \
    EXCALIDASH_MCP_PORT=3000

USER pwuser
EXPOSE 3000
CMD ["node", "src/cli.js"]
