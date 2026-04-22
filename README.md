# movie-ical

Automatically scrapes Wikipedia for upcoming US theatrical movie releases and publishes a free iCal feed via GitHub Pages. Subscribe once in Apple Calendar — movies appear automatically, forever. No API keys. No accounts. No cost.

## Setup

### 1. Create the repo

On GitHub, create a new **public** repo named `movie-ical`. Upload all files from this folder, preserving structure.

### 2. Enable GitHub Pages

Repo Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, folder: `/docs` → Save.

### 3. Run the action for the first time

Actions tab → **Update Movie Calendar** → Run workflow → wait ~20 seconds.

### 4. Subscribe in Apple Calendar

File → New Calendar Subscription → enter:

```
https://YOUR-USERNAME.github.io/movie-ical/movies.ics
```

Set auto-refresh to **Every week**. Done.

## How it works

- GitHub Actions runs every Monday at 8am UTC.
- `scripts/build.js` fetches Wikipedia's "List of American films of YYYY" pages.
- It parses the tables for upcoming release dates and titles.
- Writes a clean `movies.ics` to `docs/` and commits it.
- GitHub Pages serves the file at a permanent public URL.
- Apple Calendar polls the URL weekly and syncs new events automatically.

## Cost

Free. GitHub Actions free tier covers this with room to spare. No external APIs.
