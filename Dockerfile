# Automathink Core — imagen de producción (una imagen para todos los clientes)

# 1) Dependencias: better-sqlite3 se compila en Linux, así que esta etapa trae Python y compilador
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 2) Imagen final: solo Node + la app (sin compiladores)
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/core.sqlite \
    CLIENT_DIR=/app/client \
    BACKUP_DIR=/app/backups

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY api ./api
COPY web ./web
COPY scripts ./scripts
COPY packs ./packs
COPY clients ./clients

# Usuario sin privilegios; data/ y backups/ son volúmenes
RUN mkdir -p /app/data /app/backups /app/client && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.js"]
