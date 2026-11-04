FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --offline && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY catalog ./catalog
COPY examples ./examples
RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV NODE_ENV=production A2OS_DATA_DIR=/data A2OS_HOST=0.0.0.0 A2OS_PORT=8787 A2OS_DEVELOPMENT_PACKAGES=false
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "bin/2aos.mjs", "start"]
