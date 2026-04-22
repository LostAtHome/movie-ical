const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── HTTP GET with redirect support ───────────────────────────────────────────

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; movie-ical-bot/2.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        return get(res.headers.location, redirects - 1).then(resolve).catch(reject);
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => html += chunk);
      res.on('end', () => resolve(html));
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Parse Wikipedia "List of American films of YYYY" ─────────────────────────
//
// Page structure: h2/h3 month headings, then wikitables.
// Table columns: Opening date | Title | Production company | Director | Cast
// Rows may use rowspan for the date cell.

const MONTH_NUM = {
  january:'01', february:'02', march:'03', april:'04',
  may:'05', june:'06', july:'07', august:'08',
  september:'09', october:'10', november:'11', december:'12'
};

function parseFilmPage(html, year) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const results = [];
  const seen = new Set();

  // Split HTML on h2/h3 tags to get month sections
  const parts = html.split(/(?=<h[23][^>]*>)/i);

  let currentMonth = null;

  for (const part of parts) {
    // Detect month heading
    const headingMatch = part.match(/<h[23][^>]*>[\s\S]*?(January|February|March|April|May|June|July|August|September|October|November|December)[\s\S]*?<\/h[23]>/i);
    if (headingMatch) {
      currentMonth = MONTH_NUM[headingMatch[1].toLowerCase()];
    }
    if (!currentMonth) continue;

    // Find all <tr> blocks in this section
    const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;

    while ((trMatch = trPattern.exec(part)) !== null) {
      const rowHtml = trMatch[1];

      // Pull out <td> cells
      const tds = [];
      const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdPattern.exec(rowHtml)) !== null) {
        tds.push(stripTags(tdMatch[1]));
      }

      if (tds.length < 2) continue;

      // ── Date (first cell) ──
      const rawDate = tds[0];
      let day = null;

      // "April 3" or "April 3, 2026"
      const longDate = rawDate.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
      if (longDate) {
        currentMonth = MONTH_NUM[longDate[1].toLowerCase()];
        day = longDate[2].padStart(2, '0');
      } else {
        // Plain day number "3" or "03"
        const shortDay = rawDate.match(/^(\d{1,2})$/);
        if (shortDay) day = shortDay[1].padStart(2, '0');
      }

      if (!day) continue;

      // ── Title (second cell) ──
      let title = tds[1]
        .replace(/\(.*?\)/g, '')   // strip parentheticals like (limited)
        .replace(/\[.*?\]/g, '')   // strip footnotes like [1]
        .trim();

      if (!title || title.length < 2) continue;
      if (/^(title|film|movie|opening|release date)/i.test(title)) continue;

      // ── Build and validate date ──
      const dateStr = `${year}-${currentMonth}-${day}`;
      const releaseDate = new Date(dateStr + 'T12:00:00');
      if (isNaN(releaseDate) || releaseDate < today) continue;

      const key = `${dateStr}::${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ title, releaseDate: dateStr });
    }
  }

  results.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return results;
}

// ─── Build .ics ───────────────────────────────────────────────────────────────

function buildICS(movies) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//lostathome//movie-ical//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:🎬 Theater Releases',
    'X-WR-CALDESC:Upcoming US theatrical releases. Updated every Monday.',
    'REFRESH-INTERVAL;VALUE=DURATION:P1W',
    'X-PUBLISHED-TTL:P1W',
  ];

  movies.forEach((m, i) => {
    const start = m.releaseDate.replace(/-/g, '');
    const endDate = new Date(m.releaseDate + 'T00:00:00Z');
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const end = endDate.toISOString().slice(0, 10).replace(/-/g, '');
    const uid = `movie-${start}-${i}@lostathome-movie-ical`;
    const summary = m.title.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${summary}`,
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ─── Build index.html ─────────────────────────────────────────────────────────

function buildHTML(movies, username) {
  const feedUrl = `https://${username}.github.io/movie-ical/movies.ics`;
  const rows = movies.map(m => `
    <tr>
      <td>${m.releaseDate}</td>
      <td>${m.title}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Theater Releases iCal</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 32px; }
  .box { background: #f5f5f5; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
  .box p { font-size: 13px; color: #555; margin-bottom: 8px; }
  .url { font-family: monospace; font-size: 13px; word-break: break-all; background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 10px 14px; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 24px; }
  th { text-align: left; font-size: 12px; color: #888; font-weight: 500; padding: 0 0 8px; border-bottom: 1px solid #eee; }
  td { padding: 8px 0; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td:first-child { color: #888; font-size: 13px; width: 120px; padding-right: 12px; white-space: nowrap; }
  .count { font-size: 13px; color: #888; margin-top: 8px; }
  footer { margin-top: 40px; font-size: 12px; color: #bbb; }
</style>
</head>
<body>
<h1>🎬 Theater Releases iCal</h1>
<p class="sub">Upcoming US theatrical releases. Updated every Monday via GitHub Actions.</p>

<div class="box">
  <p>Subscribe in Apple Calendar — File &gt; New Calendar Subscription — paste this URL:</p>
  <span class="url">${feedUrl}</span>
</div>

<p class="count">${movies.length} upcoming releases</p>

<table>
  <thead><tr><th>Date</th><th>Title</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<footer>Source: Wikipedia &bull; No API keys &bull; Completely free</footer>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  const thisYear = today.getFullYear();
  const nextYear = thisYear + 1;

  const pages = [
    { url: `https://en.wikipedia.org/wiki/List_of_American_films_of_${thisYear}`, year: thisYear },
    { url: `https://en.wikipedia.org/wiki/List_of_American_films_of_${nextYear}`, year: nextYear },
  ];

  const allMovies = [];
  const globalSeen = new Set();

  for (const page of pages) {
    console.log(`Fetching ${page.url}`);
    try {
      const html = await get(page.url);
      const movies = parseFilmPage(html, page.year);
      console.log(`  -> ${movies.length} upcoming titles found`);
      for (const m of movies) {
        const key = `${m.releaseDate}::${m.title.toLowerCase()}`;
        if (!globalSeen.has(key)) {
          globalSeen.add(key);
          allMovies.push(m);
        }
      }
    } catch (err) {
      console.warn(`  -> Failed: ${err.message}`);
    }
  }

  allMovies.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  console.log(`Total: ${allMovies.length} movies`);

  if (allMovies.length === 0) {
    console.error('No movies found. Exiting without writing files.');
    process.exit(1);
  }

  const outDir = path.resolve(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });

  const icsPath = path.join(outDir, 'movies.ics');
  fs.writeFileSync(icsPath, buildICS(allMovies), 'utf8');
  console.log(`Written: ${icsPath}`);

  // Read GitHub username from env or fall back to placeholder
  const username = process.env.GITHUB_REPOSITORY
    ? process.env.GITHUB_REPOSITORY.split('/')[0]
    : 'YOUR-USERNAME';

  const htmlPath = path.join(outDir, 'index.html');
  fs.writeFileSync(htmlPath, buildHTML(allMovies, username), 'utf8');
  console.log(`Written: ${htmlPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
