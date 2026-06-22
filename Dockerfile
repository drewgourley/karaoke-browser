FROM node:18-alpine

WORKDIR /app

# Install dependencies first (layer-cached unless package.json changes)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

EXPOSE 3444

CMD ["node", "app.js"]
