FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY next.config.mjs tsconfig.json next-env.d.ts ./
COPY app ./app
COPY public ./public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build:static

FROM python:3.12-slim AS runtime
WORKDIR /app
COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/relay.py ./server/relay.py
COPY --from=frontend /app/out ./out
RUN useradd --create-home app
USER app
ENV PORT=8080
EXPOSE 8080
# One worker: relay sessions are in memory and must share a process.
CMD ["sh", "-c", "exec uvicorn relay:app --app-dir server --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
