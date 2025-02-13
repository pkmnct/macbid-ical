import dotenv from "dotenv";
import MacBid from "macbid-ts-api";
import ical from "ical-generator";
import http from "node:http";

dotenv.config();

(async () => {
  if (!process.env.ICAL_UNIQUE_URL) {
    throw new Error("You must set ICAL_UNIQUE_URL");
  }

  const api = new MacBid({
    email: process.env.MACBID_EMAIL,
    password: process.env.MACBID_PASSWORD,
  });

  const port = process.env.ICAL_PORT ? parseInt(process.env.ICAL_PORT) : 3000;
  const url = process.env.ICAL_URL || "127.0.0.1";

  http
    .createServer((req, res) => {
      if (req.url === "/" + process.env.ICAL_UNIQUE_URL) {
        console.log(`Valid incoming request, getting watchlist...`);
        (async () => {
          await api.authenticate();
          const favorites = await api.get_watchlist();
          const calendar = ical({
            name: `Mac.Bid Watchlist`,
            timezone: "America/New_York",
          });

          favorites.forEach((favorite) => {
            calendar.createEvent({
              start: favorite.expected_close_date,
              end: favorite.expected_close_date,
              summary: favorite.title,
              description: `This item is ending on Mac.bid at this time. Make sure to set a notification. The item is here: https://www.mac.bid/auction/${favorite.auction_number}/lot/${favorite.lot_number}`,
            });
          });

          calendar.serve(res);
        })();
      } else {
        console.log("Invalid incoming request", req.url, req.headers);
        res.destroy();
      }
    })
    .listen(port, url, () => {
      console.log(
        `iCal Feed Served at http://${url}:${port}/${process.env.ICAL_UNIQUE_URL}`
      );
    });
})();
