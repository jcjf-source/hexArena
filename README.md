# ⬢ Hex Arena

A browser auto battler in the style of the auto-chess genre. You draft units from a shared pool, build trait synergies, star up your units, and fight on a hex grid until one player is left. Play solo against seven bots, or online with up to seven friends (bots fill the empty seats).

It is plain HTML, CSS and JavaScript (ES modules) with **no build step**, so it runs directly on GitHub Pages.

## Play locally

ES modules don't load from `file://`, so serve the folder with any static server:

```sh
npx serve .            # or: python -m http.server 8080
```

Then open the printed URL. Adding `?autostart` to the URL skips the title screen.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
4. After a minute the game is live at `https://<user>.github.io/hex-arena/`.

All paths are relative, so it works from a project subpath. The `.nojekyll` file stops Pages from running Jekyll.

## Online play

1. One player clicks **Host online game** and shares the room code or the invite link (`?join=CODE`).
2. Friends enter the code and click **Join game**. Up to 8 players; bots take any empty seats.
3. The host clicks **Start game**. Each round, combat starts when every player is ready or the 30s timer runs out.

How it works:

- **Host-authoritative.** The host's browser runs the real game (shared pool, shops, matchmaking, every fight). Clients send actions (buy, reroll, move, ready) and receive a snapshot of their own state.
- **Peer-to-peer.** Browsers connect directly over WebRTC using [PeerJS](https://peerjs.com/). PeerJS's free public server is only used to introduce the browsers to each other. The library is loaded only when you host or join, so solo play needs no network.
- **Seeded fights.** Combat uses a seeded random number generator, so the host sends just the two teams and a seed and every browser replays the identical fight. If you are the second team, the arena is mirrored so your units are at the bottom.
- **Leaving.** If a client leaves, a bot takes over their seat. If the host closes their tab, the game ends for everyone. The host can switch tabs; the game keeps running in the background.

Limits: there is no relay (TURN) server, so some strict networks (certain workplaces, mobile carriers) may block the direct connection. The host could cheat, so this is meant for playing with friends.

## How it plays

- **Rounds:** each round has a 30s planning phase followed by automatic combat. Rounds 1–3 and every 6th round from round 9 are PvE monster rounds that drop loot.
- **Economy:** 5 gold per round, +1 interest per 10 gold held (max 5), +1–3 for win or loss streaks, +1 for a PvP win. Reroll costs 2 and 4 XP costs 4.
- **Levels:** your level is your board size (max 9). Higher levels improve shop odds for expensive units.
- **Star ups:** three copies of a unit combine into a 2★, and three 2★ into a 3★.
- **Traits:** 5 origins (Ember, Tide, Grove, Storm, Void) and 5 classes (Guardian, Striker, Ranger, Mystic, Arcanist), each with 2/4(/6) breakpoints.
- **Damage:** losing a fight costs stage damage plus the stars of every surviving enemy unit.

**Controls:** drag units between the bench and the board. Drag a unit onto the shop or right-click it to sell. Keys: `D` reroll, `F` buy XP, `E` sell the hovered unit, `Space` ready.

## Project layout

```
index.html          page shell
css/style.css       styles
js/data.js          units, traits, creeps, shop odds, XP table
js/hex.js           hex grid math (odd-r offset)
js/combat.js        combat simulation (headless-capable)
js/game.js          rounds, economy, shop/pool, matchmaking, bot AI, per-player snapshots
js/session.js       host session (runs the game) and client session (mirrors it)
js/net.js           PeerJS loading, room codes, connect helpers
js/menu.js          title screen and online lobby
js/render.js        canvas rendering and effects
js/ui.js            DOM panels and input
js/main.js          bootstrap, fight replay and game loop
tools/simulate.js   headless bot-only games for balance checks
tools/nettest.js    headless multiplayer check (snapshots, replays, leaving)
```

Run `npm test` for the headless checks, or balance-check the bots with `node tools/simulate.js 50`.
