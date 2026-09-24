FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY apps/file-service/package.json apps/file-service/package.json
COPY packages/shared-types packages/shared-types
RUN npm install --workspace=apps/file-service --omit=dev

COPY apps/file-service apps/file-service

EXPOSE 4002
CMD ["node", "apps/file-service/index.js"]
