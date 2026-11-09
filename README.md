# Bean Barrage – online (ranked league + play-a-friend)

1v1 only. The server plays both games itself (server-authoritative), so a hacked client can't fake a win.

## Run it on your computer
Needs Node 18+, nothing to install.

    node server.js
    # open http://localhost:8080 in two browser windows

## Put it online (so friend links work anywhere)
Any host that runs Node and allows WebSockets works. Two easy ones:

**Render** – New > Web Service > upload this folder (or push it to a GitHub repo) >
Runtime: Docker (uses the Dockerfile) or Node with start command `node server.js`.
Add a Disk mounted at `/app/data` so accounts and ranks survive restarts.

**Fly.io** – `fly launch` in this folder (it finds the Dockerfile), then
`fly volumes create data --size 1` and mount it at `/app/data`.

Your game is then at `https://<your-app>` and friend links look like `https://<your-app>/#room-ABCDE`.

## Modes
- **Online Ranked** – matchmaking by hidden skill (Glicko-2), best of 3, league ranks.
- **Play a Friend** – Create Room gives a 5-letter code and a link (press C to copy). Your friend opens the link,
  or types the code under Join With Code. Friendly matches don't change your rank. Rematch after each match.

## The league
Bronze, Silver, Gold, Platinum, Diamond (divisions III > II > I, 100 Bean Points each), then **Bean Baron**
(open ladder). The top 10 Barons hold the **Golden Crown**.
- 5 placement matches seed you (up to Gold II) from your hidden skill.
- Win about +20 BP, lose about -19; your hidden skill vs your division shifts that by up to ~10.
- **Hot Streak**: 3+ wins in a row = bonus BP and a flaming badge.
- **Shell Shield**: after a promotion you can't drop for 3 games.
- **Promo Clash**: Division I at 100 BP = one all-or-nothing match to enter the next tier (lose it: back to 70 BP).

## Files
- `server.js` – web + WebSocket server, matchmaking, rooms, matches, ratings, league, leaderboard
- `engine.js` – game rules (same file the browser uses)
- `public/index.html` – the game with online modes switched on
- `data/players.json` – created on first run

API: `GET /api/leaderboard`, `GET /api/status`.

## Prototype limits
- Every key press goes through the server: on a distant server you'll feel the ping. Next step is client-side prediction.
- Accounts are guest tokens saved in the browser (no email login yet).
- Character unlocks are stored in each player's browser and aren't checked by the server.
