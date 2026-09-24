FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY apps/auth-service/package.json apps/auth-service/package.json
COPY packages/shared-types packages/shared-types
RUN npm install --workspace=apps/auth-service --omit=dev

COPY apps/auth-service apps/auth-service

EXPOSE 4001
CMD ["node", "apps/auth-service/index.js"]
