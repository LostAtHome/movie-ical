const https = require('https');
const fs = require('fs');
const path = require('path');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'movie-ical-bot/2.0 (https://github.com/lostathome/movie-ical)',
        'Accept': 'text/html',
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

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'').replace(/\s+/g,' ').trim();
}

async function main() {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/html/List_of_American_films_of_2026';
  console.log('Fetching...');
  const html = await get(url);
  console.log(`HTML length: ${html.length}`);

  // Dump first 30 table rows that contain td cells, showing raw HTML
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let count = 0;
  let m;
  while ((m = trRe.exec(html)) !== null && count < 30) {
    const row = m[1];
    if (!/<td\b/i.test(row)) continue;
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let tm;
    while ((tm = tdRe.exec(row)) !== null) {
      cells.push(stripTags(tm[1]).slice(0, 60));
    }
    if (cells.length < 2) continue;
    console.log(`ROW ${count}: [${cells.join(' | ')}]`);
    count++;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
