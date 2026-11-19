import { XMLParser } from 'fast-xml-parser';
import { fetchText, fetchJson } from '../util/http.js';
import { stripHtml, clip, toIso } from '../util/text.js';
import { jobSources } from './jobs.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? '' : typeof x === 'object' ? (x['#text'] ?? '') : String(x));

// Each item: { url, title, summary, published_at, meta? }
// meta.entity lets a structured source skip LLM extraction.
export function parseFeed(body) {
  if (/<!DOCTYPE\b/i.test(body)) throw new Error('Feed document types are not supported');
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
        published_at: toIso(txt(e.published)),
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
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
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
  ...jobSources,
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

const fast = { cadence_min: 10, min_cadence: 5, max_cadence: 20 };
export const SEED_SOURCES = [
  { ...fast, id: 'rd-india-early-career', name: 'India startup communities · early-career openings', kind: 'reddit', category: 'voice',
    params: { sub: 'developersIndia+IndianStartups', assumeIndia: true, search: '(hiring OR opening) AND (intern OR fresher OR junior OR "SDE 1")' } },
  { ...fast, id: 'gn-india-early-career', name: 'Startup engineering internships & new-grad hiring', kind: 'gnews',
    params: { query: 'India startup ("engineering intern" OR "SDE 1" OR "junior backend" OR "AI engineer") hiring when:1d', assumeIndia: true } },
  { ...fast, id: 'rd-bangalorejob', name: 'Reddit r/bangalorejob', kind: 'reddit', category: 'voice', params: { sub: 'bangalorejob', assumeIndia: true } },
  { ...fast, id: 'yc-jobs-india', name: 'YC startup engineering jobs · India', kind: 'ycjobs', params: {} },
  { ...fast, id: 'hn-hiring-comments', name: 'HN Who is hiring? · employer posts', kind: 'hnhiring', params: {} },
  ...[['sarvam', 'Sarvam'], ['Meraki-Labs', 'Meraki Labs'], ['certa', 'Certa'], ['composio', 'Composio']].map(([board, company]) => ({
    ...fast, id: 'ashby-' + board.toLowerCase(), name: company + ' careers', kind: 'ashby', params: { board, company }
  })),
  { id: 'indexed-jobs-india', name: 'Google Jobs · requires SERPAPI_API_KEY', kind: 'indexedjobs', enabled: false,
    cadence_min: 60, min_cadence: 60, max_cadence: 120,
    params: { assumeIndia: true, query: 'startup junior backend OR full stack OR AI engineer OR software engineering intern India since yesterday' } },
  { ...fast, id: 'x-hiring-india', name: 'X hiring posts · requires X_BEARER_TOKEN', kind: 'xjobs', enabled: false,
    params: { query: '(hiring OR internship) (backend OR fullstack OR "AI engineer" OR "software engineer" OR SDE) (India OR Bengaluru OR Bangalore OR remote) -is:retweet lang:en' } },
  ...[
    ['linkedin', 'LinkedIn Jobs', 'https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=India&f_TPR=r86400&f_E=1%2C2&sortBy=DD'],
    ['indeed', 'Indeed India', 'https://in.indeed.com/jobs?q=software+engineer+fresher&fromage=1&sort=date'],
    ['naukri', 'Naukri', 'https://www.naukri.com/software-engineer-jobs?k=software%20engineer&experience=0&jobAge=1'],
  ].map(([id, name, url]) => ({ ...fast, cadence_min: 20, id: 'reader-' + id, name: name + ' · public listings', kind: 'reader', params: { url, assumeIndia: true } })),

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
