# Dockerfile (FHIR Event Forwarder Contrarreferencia Mediator)
FROM node:20-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package.json ./
RUN npm install --production
COPY . .

EXPOSE 8020

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:8020/forwardercontrarreferencia/_health || exit 1

USER appuser

CMD ["npm", "start"]
