FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY *.mjs ./
COPY *.txt ./
COPY *.json ./

RUN addgroup -S ocproxy && adduser -S ocproxy -G ocproxy \
    && mkdir -p /data && chown ocproxy:ocproxy /data

USER ocproxy
ENV NODE_ENV=production \
    OC_PROXY_FILE=/data/proxies.txt \
    OC_HOST=0.0.0.0 \
    OC_PORT=8788

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node healthcheck.mjs

# platform-agnostic default: listen on $PORT and use the host IP. The compose
# service passes --proxy-file/--free-proxies explicitly on top of this.
CMD ["node", "serve.mjs", "--host", "0.0.0.0"]
