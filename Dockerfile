# NOT yet built or run anywhere: written for the server, untested. See docs/RUNBOOK.md.
FROM node:22-slim

# tesseract reads addresses posted as screenshots.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency gets to run install-time code.
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY config ./config

# Never copy .env or a wallet into the image. Pass .env with --env-file and mount the wallet read-only.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 8787

# Dry-run unless .env AND the command line both say live (and the code switch is on).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts", "--watch"]
