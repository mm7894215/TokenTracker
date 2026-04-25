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

# --- Stage 2: Runtime ---
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist
EXPOSE 7680
CMD ["node", "bin/tracker.js", "serve", "--no-open", "--no-sync"]
