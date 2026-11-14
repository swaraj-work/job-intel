// Classifiers for startup funding/hiring market intel and Reddit hiring opportunities.
import { getConfig } from '../config.js';

const has = (re, t) => re.test(t);
const textOf = (item) => `${item.title} ${item.summary || ''}`;

// Topic -> what candidate should do about it
const TOPICS = [
  { id: 'funding-surge', cat: 'market', imp: 3, re: /\b(seed round|pre-seed|series a|raised|funding surge|venture capital)\b/i,
    so: 'Fresh capital deployed: early-stage founders will hire founding engineers in the next 14 days.' },
  { id: 'hiring-trends', cat: 'market', imp: 2, re: /\b(tech hiring|developer shortage|ai engineers?|hiring spree|job market)\b/i,
    so: 'Tech hiring trend: tailor your cold outreach hook to this demand.' },
  { id: 'yc-batch', cat: 'market', imp: 3, re: /\b(y combinator|yc w\d{2}|yc s\d{2}|demo day)\b/i,
    so: 'New YC batch announced: founders actively recruiting their initial engineering core.' },
];

export function classifyIntel(item, source) {
  const title = item.title || '';
  const t = textOf(item);
  const topic = TOPICS.find((x) => x.re.test(title) || x.re.test(t));
  if (!topic) return null;
  return { category: topic.cat, importance: topic.imp, topic: topic.id, so_what: topic.so };
}

// ---------- Reddit Startup Hiring Classifier ----------
const R_HIRING = /\b(\[hiring\]|we('re| are) hiring|hiring\b|looking for (a |an )?(developer|engineer|coder|programmer|full[- ]?stack|backend|frontend)|join our (team|startup)|founding engineer|co-?founder)\b/i;
const R_DEV_ROLES = /\b(software engineer|full[- ]?stack|backend|frontend|react|node|python|ai engineer|developer|mobile dev|devops)\b/i;
const R_EARLY_STAGE = /\b(startup|early[- ]stage|seed|pre-seed|equity|founding|first engineer|co-founder|bootstrapped)\b/i;
const R_EMAIL = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;

export const REDDIT_BANDS = [
  { id: 'high', label: 'High priority', min: 80, action: 'Reach out immediately (<1 day old, high founder responsiveness).' },
  { id: 'research', label: 'Research', min: 50, action: 'Qualify team size and find direct founder email.' },
  { id: 'monitor', label: 'Monitor', min: 0, action: 'Older or general discussion thread.' },
];
export const bandOf = (score) => REDDIT_BANDS.find((b) => score >= b.min) || REDDIT_BANDS[2];

export function classifyReddit(item, source) {
  const title = item.title || '';
  const t = textOf(item);

  // Must be hiring or looking for builders
  const isHiring = R_HIRING.test(title) || R_HIRING.test(t.slice(0, 300));
  if (!isHiring) return null;

  // Skip "for hire" / candidate job seeker posts
  if (/^\s*\[(for hire)\]/i.test(title) || /\bi am looking for a job\b/i.test(t)) return null;

  const roleMatch = R_DEV_ROLES.test(title) || R_DEV_ROLES.test(t);
  const earlyStage = R_EARLY_STAGE.test(t);
  const hasEmail = R_EMAIL.test(t);

  // 100-point model for Reddit hiring opportunities
  const parts = [
    [isHiring, 35, 'Explicit hiring post'],
    [roleMatch, 25, 'Engineering / Developer role match'],
    [earlyStage, 20, 'Early-stage startup / direct founder contact'],
    [hasEmail, 20, 'Direct contact email listed in post'],
  ];

  let score = parts.reduce((s, [on, pts]) => s + (on ? pts : 0), 0);
  const ageDays = item.published_at ? (Date.now() - new Date(item.published_at).getTime()) / 86400000 : 0;
  if (ageDays > 3) score -= 15;
  score = Math.max(0, Math.min(100, score));

  const band = bandOf(score);
  const emailMatch = t.match(R_EMAIL);
  const angle = emailMatch
    ? `Direct email in post (${emailMatch[0]}): send 5-line intro referencing this Reddit post.`
    : `Find founder's email via domain or send a short direct message.`;

  return {
    category: 'voice',
    importance: band.id === 'high' ? 3 : band.id === 'research' ? 2 : 1,
    score,
    so_what: angle,
    meta: {
      sub: item.meta?.sub || source.params?.sub || 'reddit',
      roleMatch,
      earlyStage,
      hasEmail,
      contactEmail: emailMatch ? emailMatch[0] : null,
      band: band.id,
      signals: parts.filter(([on]) => on).map(([, , label]) => label),
    },
  };
}

export const REDDIT_SEGMENTS = [
  { id: 'seed', label: 'Seed / Pre-Seed' },
  { id: 'yc', label: 'YC Startup' },
  { id: 'founding', label: 'Founding Engineer' },
  { id: 'remote', label: 'Remote Dev' },
];

export const REDDIT_INTENTS = [
  { id: 'hiring', label: 'Active Hiring' },
  { id: 'cofounder', label: 'Looking for Tech Lead' },
];

// Near-duplicate titles
const STOP = new Set(('the a an of to in on for and or with by from at as is are be its it this that says said new over into after amid via '
  + 'startup startups funding seed round raises raises hiring hires engineer developer team more how why what').split(' '));

export function titleTokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

export function isNearDup(a, b, sameTopic) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.6 || n >= 4 || (sameTopic && n >= 2);
}
