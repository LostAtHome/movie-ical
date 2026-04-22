const https = require('https');
const fs = require('fs');
const path = require('path');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'movie-ical-bot/2.0 (https://github.com/lostathome/movie-ical)',
        'Accept': 'application/json',
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body;
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'User-Agent': 'movie-ical-bot/2.0 (https://github.com/lostathome/movie-ical)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
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

function parseHTML(html, year) {
  const results = [];
  const seen = new Set();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  let currentMonth = null;

  // Find month headings: <h2...>January</h2> or <h3...>
  // Find table rows: <tr>...</tr>
  // Split on tags we care about

  // Extract all headings and table rows in document order
  const tokenRe = /<(h[23])[^>]*>([\s\S]*?)<\/h[23]>|<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = tokenRe.exec(html)) !== null) {
    if (match[1]) {
      // Heading
      const headingText = stripTags(match[2]).trim();
      for (const [name, num] of Object.entries(MONTH_NUM)) {
        if (headingText.toLowerCase().startsWith(name)) {
          currentMonth = num;
          break;
        }
      }
      continue;
    }

    // Table row
    if (!currentMonth) continue;
    const rowHtml = match[3];

    // Extract <td> cells
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }
    if (cells.length < 2) continue;

    let day = null;
    let titleIdx = 1;
    const c0 = cells[0].trim();

    // "January 5" or "May 22"
    const longDate = c0.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
    if (longDate) {
      currentMonth = MONTH_NUM[longDate[1].toLowerCase()];
      day = longDate[2].padStart(2, '0');
    } else {
      const shortDay = c0.match(/^(\d{1,2})$/);
      if (shortDay) day = shortDay[1].padStart(2, '0');
    }

    if (!day) continue;
    const dayNum = parseInt(day);
    if (dayNum < 1 || dayNum > 31) continue;

    let title = (cells[titleIdx] || '').replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
    if (!title || title.length < 2) continue;
    if (/^(title|film|opening|release|tba|tbd)/i.test(title)) continue;

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
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//lostathome//movie-ical//EN',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Theater Releases',
    'X-WR-CALDESC:Upcoming US theatrical releases. Updated every Monday.',
    'REFRESH-INTERVAL;VALUE=DURATION:P1W','X-PUBLISHED-TTL:P1W',
  ];
  movies.forEach((m, i) => {
    const start = m.releaseDate.replace(/-/g, '');
    const endDate = new Date(m.releaseDate + 'T00:00:00Z');
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const end = endDate.toISOString().slice(0, 10).replace(/-/g, '');
    const uid = `movie-${start}-${i}@lostathome-movie-ical`;
    const summary = m.title.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
    lines.push('BEGIN:VEVENT',`UID:${uid}`,`DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,`DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${summary}`,'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function buildHTML(movies, username) {
  const feedUrl = `https://${username}.github.io/movie-ical/movies.ics`;
  const rows = movies.map(m => `<tr><td>${m.releaseDate}</td><td>${m.title}</td></tr>`).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Theater Releases iCal</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;}
.url{font-family:monospace;font-size:13px;word-break:break-all;background:#f5f5f5;padding:10px;border-radius:6px;display:block;margin:8px 0 24px;}
table{width:100%;border-collapse:collapse;font-size:14px;}th{text-align:left;font-size:12px;color:#888;padding-bottom:8px;border-bottom:1px solid #eee;}
td{padding:7px 0;border-bottom:1px solid #f0f0f0;}td:first-child{color:#888;font-size:13px;width:110px;}</style>
</head><body><h1>Theater Releases iCal</h1>
<p>Apple Calendar → File → New Calendar Subscription:</p>
<span class="url">${feedUrl}</span>
<p style="font-size:13px;color:#888;margin-bottom:8px;">${movies.length} releases</p>
<table><thead><tr><th>Date</th><th>Title</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

async function main() {
  const today = new Date();
  const thisYear = today.getFullYear();
  const nextYear = thisYear + 1;

  const pages = [
    { title: `List_of_American_films_of_${thisYear}`, year: thisYear },
    { title: `List_of_American_films_of_${nextYear}`, year: nextYear },
  ];

  const allMovies = [];
  const globalSeen = new Set();

  for (const page of pages) {
    console.log(`Fetching: ${page.title}`);
    try {
      // Use Wikipedia REST API - returns clean parsed HTML
      const url = `https://en.wikipedia.org/api/rest_v1/page/html/${page.title}`;
      const html = await get(url);
      console.log(`  -> HTML length: ${html.length}`);

      // Show first heading found
      const h2match = html.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
      if (h2match) console.log(`  -> First heading: ${stripTags(h2match[1]).slice(0, 80)}`);

      const movies = parseHTML(html, page.year);
      console.log(`  -> ${movies.length} titles found`);
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

  const outDir = path.resolve(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });

  if (allMovies.length > 0) {
    const username = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[0] : 'lostathome';
    fs.writeFileSync(path.join(outDir, 'movies.ics'), buildICS(allMovies), 'utf8');
    fs.writeFileSync(path.join(outDir, 'index.html'), buildHTML(allMovies, username), 'utf8');
    console.log('Written successfully.');
  } else {
    console.error('No movies found.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
