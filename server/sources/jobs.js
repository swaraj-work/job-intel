import { load } from 'cheerio';
import { fetchText, fetchJson } from '../util/http.js';
import { clip, stripHtml, toIso } from '../util/text.js';

const YC = 'https://www.ycombinator.com';
const HN = 'https://hn.algolia.com/api/v1/search_by_date';

function postingTime(value, now = Date.now()) {
  if (/^\d{4}-\d\d-\d\dT/i.test(value)) return toIso(value);
  if (/^(?:just now|moments? ago|less than (?:a|one) minute ago)$/i.test(value)) return new Date(now).toISOString();
  const m = String(value || '').trim().match(/^(?:about |over |almost )?(\d+|a|an|one)\s+(second|minute|hour|day|week|month|year)s?(?: ago)?$/i);
  if (!m) return null;
  const seconds = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  return new Date(now - (/^\d+$/.test(m[1]) ? Number(m[1]) : 1) * seconds[m[2].toLowerCase()] * 1000).toISOString();
}

function listing(title, url, published_at, description, details) {
  return { title, url, published_at, summary: clip(description, 12000), meta: { job: details } };
}

export const jobSources = {
  async ycjobs() {
    const { text } = await fetchText(YC + '/jobs/role/software-engineer/india');
    const page = JSON.parse(load(text)('[data-page]').attr('data-page') || '{}');
    if (!Array.isArray(page.props?.jobPostings)) throw new Error('YC job listings missing from page');
    return page.props.jobPostings.map(j => listing(j.title, new URL(j.url, YC).href, postingTime(j.createdAt),
      j.companyOneLiner, { company: j.companyName, location: j.location, experience: j.minExperience,
        specialty: j.roleSpecificType, employment: j.type, approximate: !/^\d{4}-/.test(j.createdAt) }));
  },

  async ashby({ board, company }) {
    const data = await fetchJson('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(board));
    return data.jobs.filter(j => j.isListed !== false).map(j => listing(j.title, j.jobUrl, toIso(j.publishedAt),
      j.descriptionPlain || stripHtml(j.descriptionHtml), { company, employment: j.employmentType,
        location: [j.location, j.address?.postalAddress?.addressCountry, ...(j.secondaryLocations || []).map(l => l.location)].filter(Boolean).join(' · ') }));
  },

  async hnhiring() {
    const threads = await fetchJson(HN + '?query=Who%20is%20hiring&tags=story,author_whoishiring&hitsPerPage=5');
    const thread = threads.hits.find(h => /^Ask HN: Who is hiring\?/i.test(h.title));
    if (!thread) throw new Error('Hiring thread unavailable');
    const data = await fetchJson(HN + '?tags=comment,story_' + encodeURIComponent(thread.objectID) + '&hitsPerPage=200');
    return data.hits.filter(h => String(h.parent_id) === thread.objectID && h.comment_text).map(h => {
      const lines = h.comment_text.split(/<p>|<br\s*\/?>/i).map(stripHtml).filter(Boolean);
      return { title: clip(lines[0], 280), summary: clip(lines.join(' '), 4000), url: 'https://news.ycombinator.com/item?id=' + h.objectID,
        published_at: toIso(h.created_at), meta: { hiringThread: true } };
    });
  },

  async xjobs({ query }) {
    if (!process.env.X_BEARER_TOKEN) throw new Error('Set X_BEARER_TOKEN to read X hiring posts');
    const params = new URLSearchParams({ query, 'tweet.fields': 'created_at', max_results: '100' });
    const data = await fetchJson('https://api.x.com/2/tweets/search/recent?' + params, {
      headers: { authorization: 'Bearer ' + process.env.X_BEARER_TOKEN }
    });
    if (data.errors?.length && !data.data) throw new Error('X search unavailable for this query or account');
    return (data.data || []).map(p => ({ title: clip(p.text, 200), summary: p.text, published_at: toIso(p.created_at),
      url: 'https://x.com/i/web/status/' + p.id }));
  },

  async reader({ url }) {
    const { text } = await fetchText('https://r.jina.ai/' + url, { accept: 'text/plain', timeoutMs: 45000,
      headers: { 'X-Cache-Tolerance': '300' } });
    return parseReaderListings(text, url);
  },

  async indexedjobs({ query }) {
    const key = process.env.SERPAPI_API_KEY;
    if (!key) throw new Error('Set SERPAPI_API_KEY to use indexed Google Jobs search');
    const params = new URLSearchParams({ engine: 'google_jobs', q: query, location: 'India', gl: 'in', hl: 'en', api_key: key });
    let data;
    try {
      data = await fetchJson('https://serpapi.com/search.json?' + params);
    } catch (cause) {
      // The provider authenticates via query string. Keep that URL out of logs and source status.
      const err = new Error('Google Jobs provider request failed' + (cause.status ? ' (HTTP ' + cause.status + ')' : ''));
      err.status = cause.status;
      throw err;
    }
    if (data.error && !/hasn.t returned any results/i.test(data.error)) throw new Error('Google Jobs search unavailable. Check the provider quota and credentials.');
    const reference = Date.parse(data.search_metadata?.created_at) || Date.now();
    return (data.jobs_results || []).flatMap(j => {
      const apply = j.apply_options?.find(a => /^https?:\/\//i.test(a.link));
      if (!apply) return [];
      return [listing(j.title, apply.link, postingTime(j.detected_extensions?.posted_at, reference),
        j.description, { company: j.company_name, location: j.location, publisher: apply.title || j.via, approximate: true })];
    });
  }
};

export function parseReaderListings(text, url) {
  if (/^# (?:Additional Verification Required|Access Denied|Just a moment|Security Check)|^Warning: Target URL returned error [45]\d\d/im.test(text)) {
    throw new Error('The publisher did not return a public listings page');
  }
  const markdown = text.split(/^Markdown Content:\s*$/m).pop();
  const host = new URL(url).hostname;
  const linkedin = /(?:^|\.)linkedin\.com$/i.test(host);
  const portalPath = linkedin ? /\/jobs\/view\// : /(?:^|\.)indeed\.com$/.test(host) ? /viewjob|[?&]jk=/ :
    /(?:^|\.)naukri\.com$/.test(host) ? /\/job-listings-/ : null;
  const rows = [];
  let current;
  for (const line of markdown.split('\n')) {
    const links = [...line.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/g)];
    const link = links.find(([, label, href]) => portalPath ? portalPath.test(href) :
      !href.startsWith('#') && /engineer|develop|intern|\bsde\b|full.?stack|backend/i.test(label)
      && !/search|view all|more jobs|jobs in|jobs near/i.test(label));
    if (link) {
      let target;
      try { target = new URL(link[2], url); } catch { continue; }
      if (!['http:', 'https:'].includes(target.protocol) || target.href === url) continue;
      if (linkedin) target.search = '';
      current = { title: link[1], url: target.href, lines: [] };
      rows.push(current);
    } else if (!portalPath && /^\s*(?:[-*]|#{1,4})\s+\[/.test(line) && links.length) {
      current = null;
    }
    if (current && current.lines.length < 18) current.lines.push(line);
  }
  if (!rows.length && /captcha|access denied|forbidden|additional verification required|sign in to (?:view|continue)/i.test(text)) {
    throw new Error('Public listings unavailable from this page');
  }
  return rows.map(r => {
    const body = r.lines.join(' ').replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const date = body.match(/\bjust now\b|\bmoments? ago\b|\b(?:\d+|an?)\s+(?:minutes?|hours?|days?|weeks?) ago\b|\b\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)/i)?.[0];
    const company = linkedin ? r.lines.join('\n').match(/^####\s+\[([^\]]+)\]/m)?.[1] : undefined;
    return listing(r.title, r.url, postingTime(date), body, { company, approximate: !!date && !date.includes('T') });
  });
}
