# Dockerfile (FHIR Event Forwarder ServiceRequest Mediator)
FROM node:20-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copiar definición y deps
COPY package.json ./

# Instalar solo producción
RUN npm install --production

# Copiar código
COPY . .

EXPOSE 8016

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:8016/forwarderservicerequest/_health || exit 1

USER appuser

CMD ["npm", "start"]
