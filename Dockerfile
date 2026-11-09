FROM node:20-alpine
WORKDIR /app
COPY server.js engine.js ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
