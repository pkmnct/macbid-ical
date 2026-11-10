FROM node:24

# Create app directory
WORKDIR /usr/src/macbid-ical

RUN chown node:node /usr/src/macbid-ical

USER node
COPY package*.json ./
RUN npm ci

# Bundle app source
COPY . .

EXPOSE 3000 3443

CMD [ "npm", "start" ]