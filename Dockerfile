FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

ENV MCP_TRANSPORT=http \
    MCP_PORT=8000 \
    MCP_PATH=/mcp \
    MCP_HEALTH_PATH=/healthz \
    MCP_BODY_LIMIT=50mb \
    LI_MCP_STATE_FILE=/data/linkedin-mcp-state.json

EXPOSE 8000

CMD ["node", "dist/index.js"]
