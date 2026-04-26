# --- Stage 1: Build dashboard ---
FROM node:20-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
COPY package.json /app/package.json
ARG VITE_INSFORGE_BASE_URL
ARG VITE_INSFORGE_ANON_KEY

# Build-time patch: add auth headers to fetchLocalJson for nginx→InsForge proxy.
COPY patch-api.js /app/patch-api.js
RUN node /app/patch-api.js

RUN npm run build

# --- Stage 2: Nginx serves dashboard + proxies /functions to InsForge ---
FROM nginx:alpine
ARG VITE_INSFORGE_BASE_URL
COPY --from=dashboard-build /app/dashboard/dist /usr/share/nginx/html
RUN printf 'server {\n\
    listen 7680;\n\
    root /usr/share/nginx/html;\n\
    location /functions/ {\n\
        proxy_pass INSFORGE_URL_PLACEHOLDER/functions/;\n\
        proxy_set_header Host $proxy_host;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf && \
    sed -i "s|INSFORGE_URL_PLACEHOLDER|${VITE_INSFORGE_BASE_URL}|g" /etc/nginx/conf.d/default.conf
EXPOSE 7680
CMD ["nginx", "-g", "daemon off;"]
