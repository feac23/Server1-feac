FROM ghcr.io/puppeteer/puppeteer:21.9.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

WORKDIR  /usr/src/app

COPY package*.json ./
RUN npm ci 
COPY . .
CMD ["node" , "index.js"]