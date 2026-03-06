ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.20
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev

COPY . /app

EXPOSE 8099

CMD ["node", "server.js"]
