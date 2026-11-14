import { XMLParser } from 'fast-xml-parser';
import { fetchText, fetchJson } from '../util/http.js';
import { stripHtml, clip, toIso } from '../util/text.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? '' : typeof x === 'object' ? (x['#text'] ?? '') : String(x));

// Each item: { url, title, summary, published_at, meta? }
// meta.entity lets a structured source skip LLM extraction.
export function parseFeed(body) {
  const doc = xml.parse(body);
  if (doc.rss?.channel) {
    return arr(doc.rss.channel.item).map((it) => ({
      url: txt(it.link) || txt(it.guid),
      title: stripHtml(txt(it.title)),
      summary: clip(stripHtml(txt(it['content:encoded']) || txt(it.description)), 1500),
      published_at: toIso(txt(it.pubDate) || txt(it['dc:date'])),
      meta: { publisher: txt(it.source) || undefined, categories: arr(it.category).map(txt).slice(0, 8) },
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((e) => {
      const link = arr(e.link).find((l) => !l['@rel'] || l['@rel'] === 'alternate') || arr(e.link)[0];
      return {
        url: link?.['@href'] || txt(e.id),
        title: stripHtml(txt(e.title)),
        summary: clip(stripHtml(txt(e.content) || txt(e.summary)), 1500),
        published_at: toIso(txt(e.updated) || txt(e.published)),
        meta: { author: txt(e.author?.name) || undefined },
      };
    });
  }
  if (doc['rdf:RDF']) {
    return arr(doc['rdf:RDF'].item).map((it) => ({
      url: txt(it.link), title: stripHtml(txt(it.title)), summary: clip(stripHtml(txt(it.description)), 1500), published_at: toIso(txt(it['dc:date'])),
    }));
  }
  throw new Error('Not an RSS/Atom feed');
}

let redditToken = null;
async function redditOAuth(p) {
  if (!redditToken || redditToken.exp < Date.now()) {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'JobIntelEngine/1.0',
      },
      body: 'grant_type=client_credentials',
    });
    const j = await res.json();
    if (!j.access_token) throw new Error(`Reddit auth failed: ${j.error || res.status}`);
    redditToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  }
  const path = p.comments
    ? `/r/${p.sub}/comments?limit=100`
    : p.search
      ? `${p.sub ? `/r/${p.sub}` : ''}/search?q=${encodeURIComponent(p.search)}&sort=new&t=month&limit=50${p.sub ? '&restrict_sr=1' : ''}`
      : `/r/${p.sub}/new?limit=50`;
  const data = await fetchJson(`https://oauth.reddit.com${path}`, { headers: { authorization: `bearer ${redditToken.token}` } });
  if (p.comments) {
    return (data?.data?.children || []).map((c) => c.data).filter((d) => d.body && d.link_title).map((d) => ({
      url: `https://www.reddit.com${d.permalink}`,
      title: d.link_title,
      summary: clip(d.body, 1500),
      published_at: new Date(d.created_utc * 1000).toISOString(),
      meta: { sub: d.subreddit, score: d.score, comment: true },
    }));
  }
  return (data?.data?.children || []).map((c) => c.data).filter((d) => !/^\[(for hire|meta|mod)\]/i.test(d.title)).map((d) => ({
    url: `https://www.reddit.com${d.permalink}`,
    title: d.title,
    summary: clip(d.selftext || '', 1500),
    published_at: new Date(d.created_utc * 1000).toISOString(),
    meta: { sub: d.subreddit, score: d.score, comments: d.num_comments },
  }));
}

const kinds = {
  async rss(p) {
    const { text } = await fetchText(p.url);
    let items = parseFeed(text);
    if (p.mustMatch) {
      const re = new RegExp(p.mustMatch, 'i');
      items = items.filter((i) => re.test(`${i.title} ${i.summary}`));
    }
    return items;
  },

  async gnews(p) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(p.query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const { text } = await fetchText(url);
    return parseFeed(text).map((i) => {
      // Titles look like "Headline - Publisher"; descriptions are just a link.
      const m = i.title.match(/^(.*)\s+-\s+([^-]{2,60})$/);
      return { ...i, title: m ? m[1] : i.title, summary: '', meta: { ...i.meta, publisher: m?.[2] || i.meta?.publisher, query: p.query } };
    });
  },

  async reddit(p) {
    // Prefer the official API when a (free) Reddit app is configured: far higher rate limits.
    if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) return redditOAuth(p);
    const url = p.comments
      ? `https://www.reddit.com/r/${p.sub}/comments/.rss`
      : p.search
        ? `https://www.reddit.com/${p.sub ? `r/${p.sub}/` : ''}search.rss?q=${encodeURIComponent(p.search)}&sort=new&t=month${p.sub ? '&restrict_sr=1' : ''}`
        : `https://www.reddit.com/r/${p.sub}/new/.rss`;
    const { text } = await fetchText(url);
    // Comment feed titles read "/u/name on Post title"; keep only the post title (no usernames stored).
    if (p.comments) return parseFeed(text).map((i) => ({ ...i, title: i.title.replace(/^\/?u\/\S+ on /, ''), summary: clip(i.summary, 1500), meta: { sub: p.sub, comment: true } }));
    return parseFeed(text).filter((i) => !/^r\/\w+$/.test(i.title) && !/^\[(for hire|meta|mod)\]/i.test(i.title)).map((i) => ({ ...i, summary: clip(i.summary.replace(/submitted by .*$/i, '').trim(), 1500), meta: { ...i.meta, sub: p.sub } }));
  },

  async hn(p) {
    const since = Math.floor(Date.now() / 1000) - (p.days || 30) * 86400;
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(p.query)}&tags=${p.tags || 'story'}&numericFilters=created_at_i>${since}&hitsPerPage=50`;
    const data = await fetchJson(url);
    return (data.hits || []).filter((h) => h.title).map((h) => ({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title,
      summary: clip(stripHtml(h.story_text || ''), 1500),
      published_at: toIso(h.created_at),
      meta: { hn: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points },
    }));
  },

  async yc(p) {
    const data = await fetchJson('https://yc-oss.github.io/api/companies/all.json', { timeoutMs: 60000, maxBytes: 60_000_000 });
    const minYear = p.minYear || 2022;
    return data
      .filter((c) => (c.regions || []).includes('India') && c.status === 'Active')
      .filter((c) => { const y = parseInt(String(c.batch || '').match(/\d{4}/)?.[0] || '0', 10); return y >= minYear; })
      .map((c) => ({
        url: c.url,
        title: `${c.name} (YC ${c.batch}): ${c.one_liner || ''}`.trim(),
        summary: clip(c.long_description || c.one_liner || '', 1200),
        published_at: c.launched_at ? new Date(c.launched_at * 1000).toISOString() : null,
        meta: {
          entity: {
            name: c.name,
            website: c.website,
            logo: c.small_logo_thumb_url,
            city: (c.all_locations || '').split(',')[0] || null,
            description: c.one_liner,
            industry: [c.industry, c.subindustry, ...(c.tags || [])].filter(Boolean).join(' / '),
            team_size: c.team_size,
            batch: c.batch,
            hiring: !!c.isHiring,
            stage: 'Seed',
            investors: ['Y Combinator'],
          },
        },
      }));
  },
};

export const SOURCE_KINDS = Object.keys(kinds);

export async function fetchSource(source) {
  const fn = kinds[source.kind];
  if (!fn) throw new Error(`Unknown source kind ${source.kind}`);
  const items = await fn(source.params);
  return items.filter((i) => i.url && i.title);
}

// Seed catalogue for Seed funding, fresh hiring posts, YC startups, and builder feeds.
export const RETIRED_SOURCES = ['rd-fira', 'rd-saas-india', 'rbi-press', 'rbi-notifications', 'gn-competitors', 'gn-xb-payments', 'gn-export-policy', 'gn-payglocal'];

export const SEED_SOURCES = [
  // Indian startup funding & tech news (Seed & early stage announcements)
  { id: 'inc42', name: 'Inc42', kind: 'rss', params: { url: 'https://inc42.com/feed/' }, cadence_min: 30 },
  { id: 'inc42-buzz', name: 'Inc42 Buzz', kind: 'rss', params: { url: 'https://inc42.com/buzz/feed/' }, cadence_min: 30 },
  { id: 'entrackr', name: 'Entrackr', kind: 'rss', params: { url: 'https://entrackr.com/rss' }, cadence_min: 30 },
  { id: 'yourstory', name: 'YourStory', kind: 'rss', params: { url: 'https://yourstory.com/feed' }, cadence_min: 30 },
  { id: 'et-startups', name: 'ET Startups', kind: 'rss', params: { url: 'https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570540.cms' }, cadence_min: 45 },
  { id: 'mint-companies', name: 'Mint Companies', kind: 'rss', params: { url: 'https://www.livemint.com/rss/companies' }, cadence_min: 60 },
  { id: 'techcrunch-india', name: 'TechCrunch India', kind: 'rss', params: { url: 'https://techcrunch.com/tag/india/feed/' }, cadence_min: 60 },
  { id: 'techinasia', name: 'Tech in Asia (India)', kind: 'rss', params: { url: 'https://www.techinasia.com/feed', mustMatch: 'india|indian|bengaluru|bangalore|mumbai|delhi|gurugram' }, cadence_min: 90 },

  // Google News discovery queries: Seed funding & fresh "we are hiring" alerts
  { id: 'gn-seed-funding', name: 'GNews: Seed & Pre-Seed India', kind: 'gnews', params: { query: '("seed round" OR "pre-seed" OR "raised seed" OR "raises seed") India startup when:5d' }, cadence_min: 45 },
  { id: 'gn-series-a', name: 'GNews: Series A Funding India', kind: 'gnews', params: { query: '"Series A" India startup raises when:7d' }, cadence_min: 60 },
  { id: 'gn-hiring-posts', name: 'GNews: Startup Hiring Alerts', kind: 'gnews', params: { query: '("we are hiring" OR "we\'re hiring" OR "looking for founding engineer" OR "hiring full stack") startup (India OR Bangalore OR Remote) when:2d' }, cadence_min: 45 },
  { id: 'gn-ai-startups', name: 'GNews: Indian AI Startups', kind: 'gnews', params: { query: 'Indian AI startup (raises OR funding OR launches OR hiring) when:7d' }, cadence_min: 60 },
  { id: 'gn-saas-funding', name: 'GNews: Indian SaaS Startups', kind: 'gnews', params: { query: 'Indian SaaS startup (raises OR seed OR "Series A") when:7d' }, cadence_min: 60 },
  { id: 'gn-dev-hiring', name: 'GNews: Dev & Tech Hiring', kind: 'gnews', params: { query: '("looking for developer" OR "hiring backend" OR "hiring frontend" OR "hiring software engineer") startup India when:3d' }, cadence_min: 60 },

  // Builders & Y Combinator Startups
  { id: 'yc-india', name: 'Y Combinator India Companies', kind: 'yc', params: { minYear: 2023 }, cadence_min: 720, min_cadence: 360, max_cadence: 1440 },
  { id: 'hn-who-hiring', name: 'Hacker News: Who is Hiring', kind: 'hn', params: { query: 'Who is hiring', tags: 'ask_hn', days: 45 }, cadence_min: 180 },
  { id: 'hn-india', name: 'Hacker News: India Builders', kind: 'hn', params: { query: 'India', tags: 'show_hn', days: 30 }, cadence_min: 180 },
  { id: 'hn-bangalore', name: 'Hacker News: Bangalore Builders', kind: 'hn', params: { query: 'Bangalore', days: 30 }, cadence_min: 180 },

  // Reddit Hiring & Startup Subreddits
  { id: 'rd-devs-india', name: 'Reddit r/developersIndia (Hiring)', kind: 'reddit', category: 'voice', params: { sub: 'developersIndia', search: 'hiring OR "job opening" OR "looking for" OR "join us"' }, cadence_min: 60 },
  { id: 'rd-indianstartups', name: 'Reddit r/IndianStartups (Hiring & Seed)', kind: 'reddit', category: 'voice', params: { sub: 'IndianStartups', search: 'hiring OR "co-founder" OR "looking for developer" OR raised OR seed' }, cadence_min: 60 },
  { id: 'rd-startupindia', name: 'Reddit r/StartUpIndia (Hiring)', kind: 'reddit', category: 'voice', params: { sub: 'StartUpIndia', search: 'hiring OR "join our team" OR "looking for"' }, cadence_min: 60 },
  { id: 'rd-remote-jobs', name: 'Reddit Remote Jobs (Developer)', kind: 'reddit', category: 'voice', params: { sub: 'remotejobs+forhire', search: 'hiring (developer OR engineer OR "full stack" OR backend)' }, cadence_min: 90 },
];
