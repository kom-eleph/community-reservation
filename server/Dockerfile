FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm ci

COPY src ./src

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "start"]
