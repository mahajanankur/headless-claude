# Gateway image: one image, two commands (API and worker).
#   docker build -t headless-claude .
#   API:    docker run ... headless-claude node src/api/server.js
#   Worker: docker run ... headless-claude node src/worker/index.js
FROM node:20-bookworm-slim

ARG DOCKER_CLI_VERSION=27.3.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" \
       | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/gateway
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY config ./config
COPY src ./src
COPY skills ./skills
COPY scripts ./scripts
COPY .sequelizerc ./

ENV NODE_ENV=production
USER node
EXPOSE 4100
CMD ["node", "src/api/server.js"]
