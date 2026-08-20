FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=4000
ENV DB_PATH=/app/data/infinity.db
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 4000

# Seed on first boot only if the DB file doesn't exist yet, then start.
CMD sh -c "node -e \"require('./src/db')\" && (test -f /app/data/.seeded || (node src/seed.js && touch /app/data/.seeded)) && node src/index.js"
