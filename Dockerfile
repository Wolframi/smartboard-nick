# SmartBoard — Agile-доска в Docker
# Сборка: docker build -t smartboard .
# Запуск: docker run -d -p 3000:3000 -v smartboard-data:/app/data --env SMARTBOARD_DATA_DIR=/app/data smartboard

FROM node:20

WORKDIR /app

# Зависимости
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Данные храним снаружи (volume)
ENV SMARTBOARD_DATA_DIR=/app/data
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

EXPOSE 3000

CMD ["node", "server.js"]
