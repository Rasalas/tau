FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY service.mjs serve.mjs route-store.mjs firestore.mjs cloud-store.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV TAU_CONNECT_BIND=0.0.0.0 TAU_CONNECT_BEHIND_TLS_PROXY=1 PORT=8787
EXPOSE 8787
CMD ["node", "serve.mjs"]
