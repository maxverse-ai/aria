# Runtime image for the docs site. Build the app on the host first:
#   pnpm install && pnpm build
# then:
#   docker build -t aria-docs .
# The standalone output bundles a minimal server.js + traced node_modules.
FROM node:22-alpine

WORKDIR /app

COPY .next/standalone/site/ ./
COPY .next/static ./.next/static

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["node", "server.js"]
