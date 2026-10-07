FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY apps/file-service/package.json apps/file-service/package.json
COPY packages/shared-types packages/shared-types
COPY packages/logger packages/logger
COPY packages/http-utils packages/http-utils
COPY packages/validation packages/validation
COPY packages/queue packages/queue
RUN npm install --workspace=apps/file-service --omit=dev

COPY apps/file-service apps/file-service

EXPOSE 4002
CMD ["node", "apps/file-service/index.js"]
