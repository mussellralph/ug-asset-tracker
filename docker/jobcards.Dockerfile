FROM node:22-alpine
WORKDIR /app
COPY jobcards/package.json ./package.json
RUN npm install --omit=dev
COPY jobcards/assets/ ./assets/
COPY jobcards/server.js ./server.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
