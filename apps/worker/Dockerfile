FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/queue packages/queue
RUN npm install --workspace=apps/worker --omit=dev

COPY apps/worker apps/worker

# No EXPOSE: locally the worker has no HTTP at all. On Render (free Web
# Service) it binds $PORT for a read-only /health endpoint only.
CMD ["node", "apps/worker/index.js"]
