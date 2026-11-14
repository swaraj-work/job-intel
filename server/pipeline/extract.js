import { getConfig } from '../config.js';
import { q } from '../db.js';
import * as llm from './llm.js';
import { parseAmountUsdM, clip, domainOf } from '../util/text.js';
import { peopleFromText, teamFromText } from './people.js';

// ---------- shared vocab ----------
export const SECTOR_RULES = [
  ['Edtech', /\b(edtech|education|learning|upskill|test prep|students?|tutor|school|university|coaching)\b/i],
  ['Travel', /\b(travel|tourism|hotels?|hospitality|trips?|visa|flights?|holiday|traveltech)\b/i],
  ['Healthtech', /\b(health|healthtech|medtech|clinic|pharma|diagnostic|hospital|medical|wellness)\b/i],
  ['Fintech', /\b(fintech|lending|nbfc|insurtech|wealth|neobank|credit|loans?|payments? (app|startup|platform)|stock broking|trading app)\b/i],
  ['Gaming', /\b(gaming|game studio|games?|esports)\b/i],
  ['D2C', /\b(d2c|direct-to-consumer|consumer brand|apparel|fashion|beauty|skincare|personal care|jewell?ery|footwear|snacks?|beverages?|home decor|furniture|ethnic wear|ayurved|nutrition|pet food|coffee|tea brand)\b/i],
  ['Exporter', /\b(exporters?|exports? (of|to)|export house|handicrafts?|textiles?|garments?|spices|seafood|carpets?|leather goods|gems?)\b/i],
  ['SaaS', /\b(saas|b2b software|software platform|crm|erp|api|devtools?|developer tools?|cloud|platform for (businesses|enterprises)|enterprise software|workflow|cybersecurity|security platform|observability|analytics platform)\b/i],
  ['Manufacturing', /\b(manufactur\w*|factory|industrial|electronics|semiconductors?|ev|electric vehicles?|drones?|aerospace|defence|robotics|hardware|chemicals?)\b/i],
  ['Logistics', /\b(logistics|shipping|supply chain|freight|warehous\w*|last-mile|cargo)\b/i],
  ['Agency', /\b(agency|marketing services|design studio|creative studio|consultancy|outsourcing|bpo|kpo|staffing)\b/i],
  ['IT Services', /\b(it services|software services|digital transformation|software development|engineering services|gcc|global capability)\b/i],
  ['Marketplace', /\b(marketplace|b2b commerce|quick commerce|e-?commerce|social commerce)\b/i],
  ['AI', /\b(ai|artificial intelligence|genai|gen ai|llms?|machine learning|agents?|agentic)\b/i],
  ['Media', /\b(media|content|creators?|ott|streaming|publishing|podcast)\b/i],
];

export function guessSector(text) {
  for (const [name, re] of SECTOR_RULES) if (re.test(text)) return name;
  return 'Other';
}

const MARKETS = [
  ['US', /\b(us|u\.s\.|usa|united states|america|american|north america|silicon valley|new york|san francisco)\b/i],
  ['UK', /\b(uk|u\.k\.|united kingdom|britain|london)\b/i],
  ['UAE', /\b(uae|dubai|abu dhabi|emirates)\b/i],
  ['Middle East', /\b(middle east|gcc|saudi|ksa|riyadh|qatar|oman|kuwait|bahrain|mena)\b/i],
  ['Europe', /\b(europe|european|eu|germany|france|netherlands|spain|italy|nordics?)\b/i],
  ['Southeast Asia', /\b(southeast asia|sea|singapore|indonesia|malaysia|thailand|vietnam|philippines)\b/i],
  ['Australia', /\b(australia|new zealand|anz)\b/i],
  ['Africa', /\b(africa|nigeria|kenya|south africa|egypt)\b/i],
  ['Canada', /\b(canada|toronto)\b/i],
  ['Japan', /\b(japan|tokyo)\b/i],
  ['Global', /\b(global(ly)?|worldwide|international(ly)?|overseas|abroad|cross-border)\b/i],
];

export function detectMarkets(text) {
  return MARKETS.filter(([, re]) => re.test(text)).map(([m]) => m);
}

const STAGE_RE = /\b(pre-seed|pre seed|angel|seed|pre-series [a-e]|series [a-f]|bridge|debt|pre-ipo|grant)\b/i;
export function normStage(s) {
  if (!s) return null;
  const m = String(s).match(STAGE_RE);
  if (!m) return null;
  const v = m[1].toLowerCase().replace('pre seed', 'pre-seed');
  const fixed = { 'pre-seed': 'Pre-Seed', angel: 'Angel', seed: 'Seed', bridge: 'Bridge', debt: 'Debt', 'pre-ipo': 'Pre-IPO', grant: 'Grant' };
  if (fixed[v]) return fixed[v];
  const ps = v.match(/^pre-series ([a-e])/);
  if (ps) return `Pre-Series ${ps[1].toUpperCase()}`;
  return `Series ${v.slice(-1).toUpperCase()}`;
}

export function isEnterpriseName(name, cfg = getConfig()) {
  const lc = String(name).toLowerCase();
  return cfg.enterpriseNames.some((n) => {
    const e = n.toLowerCase();
    return lc === e || lc.startsWith(`${e} `) || (e.length >= 4 && lc.startsWith(e));
  });
}

// ---------- heuristic (no-LLM) extraction ----------
const FUND_VERBS = 'raises|raised|secures|secured|bags|bagged|lands|nets|mops up|picks up|gets|receives|closes|scoops up|garners|snags|grabs|attracts|announces|in talks to raise|to raise|eyes';
const EXP_VERBS = 'expands|expanding|enters|forays into|launches in|launches operations in|sets up|opens|goes global|takes .* global|debuts in|partners with|acquires|launches';
const DESCRIPTOR = /^.*\b(startup|start-up|brand|platform|company|firm|maker|player|provider|marketplace|unicorn|soonicorn|fintech|edtech|healthtech|agritech|spacetech|deeptech|cleantech|proptech|insurtech|traveltech|saas|d2c|nbfc|lender|based|backed|owned|bound|operator|manufacturer|exporter|venture|app|unit|subsidiary|arm|major|giant|parent|retailer|chain|studio|label)\s+/i;

function cleanHead(head) {
  let h = head.replace(/^(exclusive|funding alert|breaking|report|update|just in|funding)\s*[:|-]\s*/i, '').replace(/^\[[^\]]+\]\s*/, '').trim();
  h = h.split(/[:|]/).pop().trim();
  const stripped = h.replace(DESCRIPTOR, '').trim();
  if (stripped && /^[A-Za-z0-9]/.test(stripped) && /[A-Z0-9]/.test(stripped)) h = stripped;
  h = h.replace(/['’]s$/, '').replace(/^(the|india's|indian)\s+/i, '').replace(/\s+(ipo|group)$/i, '').trim();
  return h;
}

function plausibleName(name, cfg) {
  if (!name || name.length < 2 || name.length > 40) return false;
  if (!/^[A-Za-z0-9]/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 4) return false;
  if (/^[a-z]/.test(name) && !/[A-Z]/.test(name)) return false; // all-lowercase phrase
  if (/\b(startups?|companies|firms|brands|investors|government|centre|india|report|week|this|these|how|why|what|here)\b/i.test(name) && words.length > 1) return false;
  if (/\b(co-?founder|founder|ceo|minister|chairman|md|missile|ministry|mutual fund|govt|government)\b/i.test(name)) return false;
  const lc = name.toLowerCase();
  if ((cfg.blocklist || []).some((b) => b.toLowerCase() === lc)) return false;
  if ((cfg.competitors || []).some((b) => b.toLowerCase() === lc)) return false;
  return true;
}

function heuristicLead(item, source, cfg) {
  const text = `${item.title}. ${item.summary || ''}`;
  let name = null, type = 'other';
  const f = item.title.match(new RegExp(`^(.*?)\\s+(${FUND_VERBS})\\b`, 'i'));
  const e = item.title.match(new RegExp(`^(.*?)\\s+(${EXP_VERBS})\\b`, 'i'));
  // Investor-first headlines: "Chiratae leads $10 Mn round in quantum startup Quanfluence".
  const inv = !f || !/raise|secure|bag|land|net|mop|pick|get|receive|close|scoop|garner|snag|grab|attract/i.test(f[2])
    ? item.title.match(/\b(?:leads?|invests?|backs?|bets on|pumps|puts|co-leads?|participates)\b.*?\b(?:startup|start-up|brand|platform|company|firm|maker|challenger|player|provider)\s+([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,2})/)
    : null;
  const showHn = item.title.match(/^Show HN:\s*(.+?)\s*(?:\s[–—-]\s|:|,|$)/);
  const h = item.title.match(/^(.*?)\s+(?:is\s+)?(?:hiring|hires|looking for|seeking|recruiting)\b/i);
  const intlHere = detectMarkets(item.title).length > 0;
  if (f && /raise|secure|bag|land|net|mop|pick|get|receive|close|scoop|garner|snag|grab|attract/i.test(f[2]) && (parseAmountUsdM(item.title) || STAGE_RE.test(text) || /fund|round|invest/i.test(text))) {
    name = cleanHead(f[1]); type = 'funding';
  } else if (inv && /round|invest|back|crore|mn|million|seed|series/i.test(item.title)) {
    name = cleanHead(inv[1]); type = 'funding';
  } else if (h) {
    name = cleanHead(h[1]); type = 'hiring';
  } else if (e && intlHere && !/acquires|partners/i.test(e[2])) {
    name = cleanHead(e[1]);
    type = /launches$/i.test(e[2]) ? 'launch' : 'expansion';
  } else if (showHn) {
    name = showHn[1].trim(); type = 'launch';
  }
  if (!plausibleName(name, cfg)) return null;

  const amountTxt = type === 'funding' ? raiseAmountText(item.title) || raiseAmountText(item.summary) : null;
  const amount_usd_m = amountTxt ? parseAmountUsdM(amountTxt) : null;
  const investors = [];
  const led = text.match(/led by ([A-Z][^,.;()]+?)(?:,|\.|;| and | with | along| alongside| to |$)/);
  if (led) investors.push(led[1].trim());
  const city = text.match(/\b(Bengaluru|Bangalore|Mumbai|Delhi|Gurugram|Gurgaon|Noida|Pune|Hyderabad|Chennai|Kolkata|Ahmedabad|Jaipur|Surat|Kochi|Chandigarh|Indore|Coimbatore)\b/)?.[1] || null;
  // Strip the company's own name so "ReFit Global" is not read as a global signal.
  const textNoName = text.split(name).join(' ');
  const markets = detectMarkets(textNoName);
  const hiringSignals = (cfg.keywords?.hiring || []).filter((k) => new RegExp(`\\b${escapeRe(k)}\\b`, 'i').test(textNoName));
  const competitors = (cfg.competitors || []).filter((c) => new RegExp(`\\b${escapeRe(c)}\\b`, 'i').test(text));
  const enterprise = isEnterpriseName(name, cfg) || (amount_usd_m || 0) > 150 || /\b(listed|nse|bse|pre-ipo)\b/i.test(text);

  return {
    name,
    people: peopleFromText(text, name),
    team: teamFromText(text),
    website: null,
    is_indian: true,
    city,
    sector: guessSector(text),
    size: enterprise ? 'enterprise' : 'startup',
    description: clip(item.summary || item.title, 220),
    sells_intl: markets.length ? 'likely' : 'unknown',
    markets: markets.filter((m) => m !== 'Global').concat(markets.includes('Global') ? ['Global'] : []),
    payment_pain: null,
    confidence: type === 'funding' ? 0.6 : 0.45,
    event: {
      type,
      title: item.title,
      summary: clip(item.summary || '', 400),
      stage: type === 'funding' ? normStage(text) : null,
      amount_text: amountTxt,
      amount_usd_m,
      investors,
      signals: [...new Set(hiringSignals)].slice(0, 6),
      competitors,
    },
  };
}

// First money amount that is not a valuation ("at Rs 16.7 Cr valuation").
function raiseAmountText(t = '') {
  const re = /(US\$|USD|\$|₹|INR|Rs\.?)\s?[\d.,]+\s?(mn|million|m\b|cr\b|crore|bn|billion|b\b|lakh|k\b)?/gi;
  for (const m of String(t).matchAll(re)) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 18);
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    if (/valuation|valued/i.test(after) || /(\bat|valuation of|valued at|revenue of|turnover of|revenue to|worth)\s*(a\s+)?$/i.test(before)) continue;
    return m[0].trim();
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function structuredLead(item, cfg) {
  const e = item.meta.entity;
  const text = `${e.description || ''} ${e.industry || ''} ${item.summary || ''}`;
  const markets = detectMarkets(text);
  const b2b = /b2b|saas|developer|enterprise|api|infrastructure/i.test(e.industry || '');
  const hiring = Boolean(e.hiring);
  return {
    name: e.name,
    team: e.team_size ? { min: e.team_size, max: e.team_size, exact: true, evidence: `Team size listed on Y Combinator (${e.batch})` } : null,
    website: e.website,
    logo: e.logo,
    is_indian: true,
    city: e.city,
    sector: guessSector(`${e.industry} ${e.description}`),
    size: 'startup',
    description: clip(e.description || item.summary, 220),
    sells_intl: b2b || markets.length ? 'likely' : 'unknown',
    markets: markets.length ? markets : b2b ? ['US', 'Global'] : [],
    payment_pain: null,
    confidence: 0.88,
    event: {
      type: hiring ? 'hiring' : 'funding',
      title: hiring ? `YC ${e.batch} startup is actively hiring` : `Backed by Y Combinator (${e.batch})`,
      summary: clip(item.summary, 400),
      stage: 'Seed',
      amount_text: '$500K (YC deal)',
      amount_usd_m: 0.5,
      investors: ['Y Combinator'],
      signals: ['YC-backed', hiring ? 'actively hiring' : null, e.batch ? `YC ${e.batch}` : null].filter(Boolean),
      competitors: [],
    },
  };
}

// ---------- LLM extraction ----------
const SECTORS_ENUM = () => Object.keys(getConfig().sectors);

const SCHEMA = () => ({
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          leads: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                website: { type: 'STRING', nullable: true },
                is_indian: { type: 'BOOLEAN' },
                city: { type: 'STRING', nullable: true },
                sector: { type: 'STRING', enum: SECTORS_ENUM() },
                size: { type: 'STRING', enum: ['micro', 'startup', 'sme', 'enterprise', 'unknown'] },
                description: { type: 'STRING' },
                sells_intl: { type: 'STRING', enum: ['yes', 'likely', 'unknown', 'no'] },
                markets: { type: 'ARRAY', items: { type: 'STRING' } },
                payment_pain: { type: 'STRING', nullable: true },
                people: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, role: { type: 'STRING' }, evidence: { type: 'STRING' } }, required: ['name', 'role'] } },
                team_size: { type: 'INTEGER', nullable: true },
                confidence: { type: 'NUMBER' },
                event: {
                  type: 'OBJECT',
                  properties: {
                    type: { type: 'STRING', enum: ['funding', 'expansion', 'launch', 'export', 'hiring', 'pain', 'partnership', 'acquisition', 'other'] },
                    title: { type: 'STRING' },
                    summary: { type: 'STRING' },
                    stage: { type: 'STRING', nullable: true },
                    amount_text: { type: 'STRING', nullable: true },
                    amount_usd_m: { type: 'NUMBER', nullable: true },
                    investors: { type: 'ARRAY', items: { type: 'STRING' } },
                    signals: { type: 'ARRAY', items: { type: 'STRING' } },
                    competitors: { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                  required: ['type', 'title', 'summary', 'investors', 'signals', 'competitors'],
                },
              },
              required: ['name', 'is_indian', 'sector', 'size', 'description', 'sells_intl', 'markets', 'confidence', 'event'],
            },
          },
          intel: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              category: { type: 'STRING', enum: ['regulatory', 'competitor', 'market', 'voice', 'payglocal'] },
              title: { type: 'STRING' },
              summary: { type: 'STRING' },
              so_what: { type: 'STRING' },
              importance: { type: 'INTEGER' },
            },
            required: ['category', 'title', 'summary', 'so_what', 'importance'],
          },
        },
        required: ['i', 'leads'],
      },
    },
  },
  required: ['results'],
});

const SYSTEM = `You are the startup talent intelligence analyst for an ambitious software engineer looking for high-growth early-stage startups to join.
Target companies: Startups (especially Seed, Pre-Seed, Angel, Series A, and Y Combinator companies) that recently raised funding or are actively hiring developers, engineers, and product builders.

Your job for each news item / post:
1. "leads": extract ONLY real, specifically named operating startups/companies that are the SUBJECT of the item (raising money, launching products, or hiring). Never extract investors, venture capital firms, publishers, or government bodies. Skip roundups unless one startup is clearly the focus.
   - is_indian: true if founded/operating in India or remote-friendly.
   - size: "startup", "sme", or "enterprise".
   - sells_intl: "yes" if building for global markets/US, "likely", or "unknown".
   - markets: target regions (e.g. "US", "Global", "India").
   - event.type: "funding", "hiring", "launch", "expansion", or "other".
   - event.amount_usd_m: amount raised in USD millions (convert INR at 85/USD; 1 crore = 10,000,000 INR). null if not stated.
   - event.stage: e.g. "Pre-Seed", "Seed", "Pre-Series A", "Series A", "Series B", or null.
   - event.signals: 2-5 short phrases highlighting what the startup is building, open roles, or why this is a high-signal team to join.
   - people: founders, co-founders, CEO, CTO, or Head of Engineering named in the item, with role and a short verbatim quote as evidence. Never investors or journalists.
   - team_size: headcount only if stated (e.g. "15-member team"), else null.
   - confidence: 0..1 that this is a real operating startup.
2. "intel": set only for notable startup ecosystem shifts or founder moves. Otherwise null.
Return one result per input item index "i". Be precise and conservative. Do not invent websites; only include a website if the item states it or it is unambiguous.`;

function feedbackHints() {
  const liked = q.all("SELECT name, sector, why FROM companies WHERE feedback = 1 ORDER BY updated_at DESC LIMIT 5");
  const disliked = q.all("SELECT name, sector, why FROM companies WHERE feedback = -1 ORDER BY updated_at DESC LIMIT 5");
  if (!liked.length && !disliked.length) return '';
  const f = (r) => `- ${r.name} (${r.sector})`;
  return `\nSales feedback so far (calibrate relevance to this):\nLiked:\n${liked.map(f).join('\n') || '- none'}\nRejected:\n${disliked.map(f).join('\n') || '- none'}\n`;
}

async function llmBatch(batch) {
  const lines = batch.map(({ item, source }, i) => [
    `### i=${i}`,
    `source: ${source.name} (${source.category})${item.meta?.publisher ? `, publisher: ${item.meta.publisher}` : ''}`,
    `date: ${item.published_at?.slice(0, 10) || 'unknown'}`,
    `url-domain: ${domainOf(item.url) || ''}`,
    `title: ${item.title}`,
    item.summary ? `text: ${clip(item.summary, 900)}` : '',
  ].filter(Boolean).join('\n'));
  const prompt = `${feedbackHints()}\nItems:\n\n${lines.join('\n\n')}`;
  const out = await llm.json(SYSTEM, prompt, SCHEMA());
  const byIdx = new Map((out.results || []).map((r) => [r.i, r]));
  return batch.map((_, i) => byIdx.get(i) || { i, leads: [], intel: null });
}

// ---------- public ----------
// batch: [{ item, source, route }] -> [{ leads: [], intel: null|{} , via }]
export async function extractBatch(batch) {
  const cfg = getConfig();
  const results = new Array(batch.length);
  const needLlm = [];
  batch.forEach((b, idx) => {
    if (b.route === 'structured') results[idx] = { leads: [structuredLead(b.item, cfg)], intel: null, via: 'structured' };
    else needLlm.push(idx);
  });

  if (needLlm.length && llm.available()) {
    try {
      const out = await llmBatch(needLlm.map((idx) => batch[idx]));
      needLlm.forEach((idx, k) => {
        const r = out[k];
        const cls = batch[idx].cls;
        // The LLM can veto or sharpen the rules verdict; rules keep the Reddit score and tags.
        const intel = r.intel && cls ? { ...cls, ...r.intel, category: cls.category === 'voice' ? 'voice' : r.intel.category, meta: cls.meta, score: cls.score } : null;
        results[idx] = { leads: (r.leads || []).map(cleanLlmLead), intel, via: 'llm' };
      });
      return results;
    } catch {
      // fall through to heuristics for this batch
    }
  }

  for (const idx of needLlm) {
    const { item, source, route, cls } = batch[idx];
    if (route === 'intel' || route === 'voice') {
      const lead = route === 'voice' ? null : heuristicLead(item, source, cfg);
      results[idx] = { leads: lead ? [lead] : [], intel: cls ? { ...cls, title: item.title, summary: clip(item.summary || '', 400) } : null, via: 'rules' };
    } else {
      const lead = heuristicLead(item, source, cfg);
      results[idx] = { leads: lead ? [lead] : [], intel: null, via: 'rules' };
    }
  }
  return results;
}

function cleanLlmLead(l) {
  return {
    ...l,
    website: l.website && domainOf(l.website) ? l.website : null,
    people: (l.people || []).slice(0, 6),
    team: l.team_size ? { min: l.team_size, max: l.team_size, exact: true, evidence: 'Headcount stated in news coverage' } : null,
    markets: [...new Set(l.markets || [])],
    confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0.5)),
    event: { ...l.event, stage: normStage(l.event?.stage) || l.event?.stage || null, investors: l.event?.investors || [], signals: l.event?.signals || [], competitors: l.event?.competitors || [] },
  };
}
