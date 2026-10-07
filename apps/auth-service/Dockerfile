FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY apps/auth-service/package.json apps/auth-service/package.json
COPY packages/shared-types packages/shared-types
COPY packages/logger packages/logger
COPY packages/http-utils packages/http-utils
COPY packages/validation packages/validation
RUN npm install --workspace=apps/auth-service --omit=dev

COPY apps/auth-service apps/auth-service

EXPOSE 4001
CMD ["node", "apps/auth-service/index.js"]
