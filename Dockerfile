FROM node:18

# Create app directory
WORKDIR /usr/src/macbid-ical

RUN chown node:node /usr/src/macbid-ical

USER node
COPY package*.json ./
RUN npm ci

# Bundle app source
COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]