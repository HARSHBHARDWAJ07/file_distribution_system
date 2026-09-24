FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared-types packages/shared-types
RUN npm install --workspace=apps/gateway --omit=dev

COPY apps/gateway apps/gateway

EXPOSE 4000
CMD ["node", "apps/gateway/index.js"]
