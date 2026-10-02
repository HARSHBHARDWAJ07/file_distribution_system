FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/queue packages/queue
RUN npm install --workspace=apps/worker --omit=dev

COPY apps/worker apps/worker

# No EXPOSE: the worker never accepts inbound traffic.
CMD ["node", "apps/worker/index.js"]
