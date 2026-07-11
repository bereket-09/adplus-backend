FROM node:20-alpine

WORKDIR /app

# Install deps first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
