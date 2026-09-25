# Simulated Servicios Proactivos portal (MAP, demo). Zero-dependency Node server.
FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node server.mjs views.mjs ./
COPY --chown=node:node public ./public

ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
