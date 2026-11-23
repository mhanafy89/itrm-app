FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Database connection comes from SQL_SERVER / SQL_PORT / SQL_DATABASE / SQL_USER / SQL_PASSWORD
# (see .env.example and docker-compose.yml).
ENV PORT=3000
EXPOSE 3000

CMD ["sh", "-c", "npm run seed && npm start"]
