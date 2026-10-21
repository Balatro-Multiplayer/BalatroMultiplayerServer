FROM node:24.22.1-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8788

CMD [ "node", "dist/main.js" ]
