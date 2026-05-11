FROM node:22-slim

WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./

# Install production deps only
RUN npm ci --production=false

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Remove dev deps after build
RUN npm prune --production

# Cloud Run sets PORT env var
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "dist/index.js"]
