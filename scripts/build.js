const https = require('https');
const fs = require('fs');
const path = require('path');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; movie-ical-bot/2.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => html += chunk);
      res.on('end', () => resolve(html));
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
}

const MONTH_NUM = {
  january:'01', february:'02', march:'03', april:'04',
  may:'05', june:'06', july:'07', august:'08',
  september:'09', october:'10', november:'11', december:'12'
};

function parseFilmPage(html, year) {
  const results = [];
  const seen = new Set();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  // Strip all HTML and work with plain text
  const text = stripTags(html);
  const lines = text.split('\n');
  let currentMonth = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── Detect month ─────────────────────────────────────────────────────────
    // Wikipedia uses spaced letters: "J A N U A R Y" "F E B R U A R Y" etc.
    // Remove all spaces and check if it matches a month name (before any colon)
    const beforeColon = trimmed.split(':')[0];
    const noSpaces = beforeColon.replace(/\s+/g, '').toLowerCase();
    let foundMonth = null;
    for (const [name, num] of Object.entries(MONTH_NUM)) {
      if (noSpaces === name) { foundMonth = num; break; }
    }
    if (foundMonth) {
      currentMonth = foundMonth;
      // Also check if there's a movie entry on the same line after the colon
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const rest = trimmed.slice(colonIdx + 1).trim();
        const m = rest.match(/^(\d{1,2})\s*[;:]\s*([^;|]+)/);
        if (m) {
          const day = m[1].padStart(2, '0');
          let title = m[2].replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
          if (title && title.length >= 2 && !/^(title|film|opening|release)/i.test(title)) {
            const dateStr = `${year}-${currentMonth}-${day}`;
            const rd = new Date(dateStr + 'T12:00:00');
            if (!isNaN(rd.getTime()) && rd >= cutoff) {
              const key = `${dateStr}::${title.toLowerCase()}`;
              if (!seen.has(key)) { seen.add(key); results.push({ title, releaseDate: dateStr }); }
            }
          }
        }
      }
      continue;
    }

    if (!currentMonth) continue;

    // ── Detect movie row ──────────────────────────────────────────────────────
    // Format: "22; The Mandalorian and Grogu; Studio; ..."
    const rowMatch = trimmed.match(/^(\d{1,2})\s*[;:]\s*([^;|]+)/);
    if (!rowMatch) continue;

    const dayNum = parseInt(rowMatch[1]);
    if (dayNum < 1 || dayNum > 31) continue;
    const day = rowMatch[1].padStart(2, '0');

    let title = rowMatch[2].replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
    if (!title || title.length < 2) continue;
    if (/^(title|film|opening|release|rank|distributor)/i.test(title)) continue;
    if (/^\$[\d,]/.test(title) || /^\d+$/.test(title)) continue;

    const dateStr = `${year}-${currentMonth}-${day}`;
    const rd = new Date(dateStr + 'T12:00:00');
    if (isNaN(rd.getTime()) || rd < cutoff) continue;

    const key = `${dateStr}::${title.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); results.push({ title, releaseDate: dateStr }); }
  }

  results.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return results;
}

function buildICS(movies) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//lostathome//movie-ical//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Theater Releases',
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
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${summary}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function buildHTML(movies, username) {
  const feedUrl = `https://${username}.github.io/movie-ical/movies.ics`;
  const rows = movies.map(m => `<tr><td>${m.releaseDate}</td><td>${m.title}</td></tr>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Theater Releases iCal</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;color:#1a1a1a;}
  h1{font-size:22px;font-weight:600;margin-bottom:6px;}
  .sub{color:#666;font-size:14px;margin-bottom:24px;}
  .box{background:#f5f5f5;border-radius:8px;padding:16px 20px;margin-bottom:24px;}
  .url{font-family:monospace;font-size:13px;word-break:break-all;background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px 14px;display:block;margin-top:8px;}
  table{width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;}
  th{text-align:left;font-size:12px;color:#888;padding-bottom:8px;border-bottom:1px solid #eee;}
  td{padding:7px 0;border-bottom:1px solid #f0f0f0;}
  td:first-child{color:#888;font-size:13px;width:110px;}
  footer{margin-top:32px;font-size:12px;color:#bbb;}
</style>
</head>
<body>
<h1>Theater Releases iCal</h1>
<p class="sub">Upcoming US theatrical releases, updated every Monday.</p>
<div class="box">
  <p style="font-size:13px;color:#555;">Subscribe in Apple Calendar — File &gt; New Calendar Subscription:</p>
  <span class="url">${feedUrl}</span>
</div>
<p style="font-size:13px;color:#888;margin-bottom:8px;">${movies.length} releases</p>
<table>
  <thead><tr><th>Date</th><th>Title</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<footer>Source: Wikipedia &bull; Free &bull; No API keys</footer>
</body>
</html>`;
}

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
      console.log(`  -> ${movies.length} titles`);
      for (const m of movies) {
        const key = `${m.releaseDate}::${m.title.toLowerCase()}`;
        if (!globalSeen.has(key)) { globalSeen.add(key); allMovies.push(m); }
      }
    } catch (err) {
      console.warn(`  -> Failed: ${err.message}`);
    }
  }

  allMovies.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  console.log(`Total: ${allMovies.length} movies`);
  if (allMovies.length === 0) { console.error('No movies found.'); process.exit(1); }

  const outDir = path.resolve(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'movies.ics'), buildICS(allMovies), 'utf8');
  console.log('Written: docs/movies.ics');

  const username = process.env.GITHUB_REPOSITORY
    ? process.env.GITHUB_REPOSITORY.split('/')[0] : 'lostathome';
  fs.writeFileSync(path.join(outDir, 'index.html'), buildHTML(allMovies, username), 'utf8');
  console.log('Written: docs/index.html');
}

main().catch(err => { console.error(err); process.exit(1); });
