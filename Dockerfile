FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY frontend ./frontend
EXPOSE 3000
CMD ["npm", "start"]
