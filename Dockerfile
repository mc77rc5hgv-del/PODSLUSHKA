FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY src/ ./src/
CMD ["node", "src/index.mjs"]
