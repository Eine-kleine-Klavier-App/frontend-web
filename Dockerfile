# Dev image: Vite dev server for `make full` in PianoAppBackend (see its docker-compose.yml,
# which mounts the sources over /app and points the /api proxy at the backend container).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# --host: reachable from outside the container.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
