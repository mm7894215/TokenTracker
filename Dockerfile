# --- Stage 1: Build dashboard ---
FROM node:20-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
COPY package.json /app/package.json
ARG VITE_INSFORGE_BASE_URL
ARG VITE_INSFORGE_ANON_KEY
RUN npm run build

# --- Stage 2: Nginx serves dashboard + proxies /functions to InsForge ---
FROM nginx:alpine
ARG VITE_INSFORGE_BASE_URL
COPY --from=dashboard-build /app/dashboard/dist /usr/share/nginx/html
RUN apk add --no-cache njs && \
    printf 'load_module modules/ngx_http_js_module.so;\n\
events { worker_connections 1024; }\n\
http {\n\
    include /etc/nginx/mime.types;\n\
    js_import /etc/nginx/ingest.js;\n\
    server {\n\
        listen 7680;\n\
        root /usr/share/nginx/html;\n\
        location = /functions/tokentracker-ingest {\n\
            js_content ingest.handle;\n\
        }\n\
        location /functions/ {\n\
            proxy_pass INSFORGE_URL_PLACEHOLDER/functions/;\n\
            proxy_set_header Host $proxy_host;\n\
            proxy_set_header X-Real-IP $remote_addr;\n\
            proxy_set_header Cookie $http_cookie;\n\
            proxy_set_header Authorization $http_authorization;\n\
            proxy_set_header apikey $http_apikey;\n\
            proxy_pass_header Set-Cookie;\n\
        }\n\
        location /api/ {\n\
            proxy_pass INSFORGE_URL_PLACEHOLDER/api/;\n\
            proxy_set_header Host $proxy_host;\n\
            proxy_set_header X-Real-IP $remote_addr;\n\
            proxy_set_header Cookie $http_cookie;\n\
            proxy_set_header Authorization $http_authorization;\n\
            proxy_pass_header Set-Cookie;\n\
        }\n\
        location / {\n\
            try_files $uri $uri/ /index.html;\n\
        }\n\
    }\n\
}\n' > /etc/nginx/nginx.conf && \
    printf 'async function handle(r) {\n\
    var bearer = r.headersIn["Authorization"] || "";\n\
    var token = bearer.replace(/^Bearer\\s+/i, "");\n\
    var hash = "";\n\
    if (token && token.split(".").length !== 3) {\n\
        var data = new TextEncoder().encode(token);\n\
        var buf = await crypto.subtle.digest("SHA-256", data);\n\
        hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");\n\
    }\n\
    var headers = { "Content-Type": r.headersIn["Content-Type"] || "application/json" };\n\
    var ak = r.headersIn["apikey"] || "";\n\
    if (ak) headers["apikey"] = ak;\n\
    if (hash) headers["x-tokentracker-device-token-hash"] = hash;\n\
    if (token && token.split(".").length === 3) headers["Authorization"] = "Bearer " + token;\n\
    var resp = await ngx.fetch("INSFORGE_URL_PLACEHOLDER/functions/tokentracker-ingest", {\n\
        method: r.method,\n\
        headers: headers,\n\
        body: r.requestBuffer\n\
    });\n\
    r.headersOut["Content-Type"] = "application/json";\n\
    r.headersOut["Access-Control-Allow-Origin"] = "*";\n\
    r.return(resp.status, await resp.text());\n\
}\n\
export default { handle };\n' > /etc/nginx/ingest.js && \
    sed -i "s|INSFORGE_URL_PLACEHOLDER|${VITE_INSFORGE_BASE_URL}|g" /etc/nginx/nginx.conf /etc/nginx/ingest.js
EXPOSE 7680
CMD ["nginx", "-g", "daemon off;"]
