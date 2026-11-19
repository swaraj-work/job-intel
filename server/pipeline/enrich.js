import * as cheerio from 'cheerio';
import { q, J, nowIso } from '../db.js';
import { fetchText } from '../util/http.js';
import { domainOf, normName, clip, fmtUsdM } from '../util/text.js';
import { getConfig } from '../config.js';
import * as llm from './llm.js';
import { log } from '../bus.js';
import { researchPeople } from './people.js';

// Tech stack detection patterns
const TECH_PATTERNS = [
  ['Next.js', /__NEXT_DATA__|\/_next\/static/i],
  ['React', /react(?:\.production|\.development)?\.js|data-reactroot|_react|reactjs/i],
  ['Vue.js', /vue(?:\.runtime)?\.js|v-bind|__NUXT__|nuxt/i],
  ['Svelte', /svelte/i],
  ['Tailwind CSS', /tailwindcss|tailwind/i],
  ['TypeScript', /typescript/i],
  ['Node.js', /nodejs|expressjs/i],
  ['Python', /python|django|fastapi/i],
  ['FastAPI', /fastapi/i],
  ['Django', /csrfmiddlewaretoken|django/i],
  ['GraphQL', /graphql|apollo-client/i],
  ['Supabase', /supabase/i],
  ['Firebase', /firebaseapp\.com|firebase/i],
  ['PostgreSQL', /postgres/i],
  ['MongoDB', /mongodb/i],
  ['AWS', /amazonaws\.com|cloudfront\.net/i],
  ['OpenAI / LLMs', /openai|gpt-[34]|langchain|anthropic/i],
];

const ATS_PATTERNS = [
  ['Greenhouse', /boards\.greenhouse\.io|job-boards\.greenhouse\.io/i],
  ['Lever', /jobs\.lever\.co/i],
  ['Ashby', /jobs\.ashbyhq\.com/i],
  ['Workable', /apply\.workable\.com/i],
  ['Recruitee', /recruitee\.com/i],
];

const PARKED = /domain (is )?for sale|buy this domain|parked free|sedoparking|hugedomains|dan\.com|godaddy\.com\/domainsearch|this domain may be for sale/i;

function analyse(html, url) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const title = $('title').first().text().trim() || $('meta[property="og:site_name"]').attr('content') || '';
  const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

  // Detect tech stack
  const techStack = TECH_PATTERNS.filter(([, re]) => re.test(html)).map(([n]) => n);
  if (techStack.includes('Next.js') && !techStack.includes('React')) techStack.push('React');

  // Detect ATS / careers link
  const ats = ATS_PATTERNS.find(([, re]) => re.test(html))?.[0] || null;
  const careersLink = $('a[href]').map((_, el) => $(el).attr('href')).get().find((h) => /\/careers\b|\/jobs\b|\/join-us\b|\/work-with-us\b/i.test(h || ''));

  const social = {};
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (!social.linkedin && /linkedin\.com\/company\//i.test(h)) social.linkedin = h.split('?')[0];
    if (!social.twitter && /(twitter|x)\.com\/[A-Za-z0-9_]+\/?$/i.test(h)) social.twitter = h;
    if (!social.github && /github\.com\/[A-Za-z0-9_-]+\/?$/i.test(h)) social.github = h;
  });

  return {
    title: clip(title, 120),
    description: clip(desc, 300),
    techStack,
    ats,
    careersLink: careersLink ? new URL(careersLink, url).toString() : null,
    social,
    textSample: text.slice(0, 4000),
  };
}

function nameMatches(name, a) {
  const n = normName(name);
  if (!n) return false;
  const hay = normName(`${a.title} ${a.description}`) + normName(a.textSample.slice(0, 1500));
  return hay.includes(n) || (n.length > 6 && hay.includes(n.slice(0, Math.ceil(n.length * 0.75))));
}

async function tryUrl(url) {
  try {
    const { text, finalUrl } = await fetchText(url, { timeoutMs: 9000, maxBytes: 2_500_000, accept: 'text/html' });
    if (PARKED.test(text.slice(0, 20000))) return null;
    return { html: text, url: finalUrl };
  } catch {
    return null;
  }
}

async function findWebsite(company) {
  if (company.website) {
    const r = await tryUrl(/^https?:/.test(company.website) ? company.website : `https://${company.website}`);
    if (r) return r;
  }
  const slug = company.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const slugCore = normName(company.name);
  const cands = [...new Set([`${slug}.com`, `${slug}.in`, `${slug}.ai`, `${slug}.io`, `${slugCore}.com`, `get${slug}.com`, `${slug}.co`, `${slug}.co.in`])];
  for (const d of cands.slice(0, 6)) {
    const r = await tryUrl(`https://${d}`);
    if (!r) continue;
    const a = analyse(r.html, r.url);
    if (nameMatches(company.name, a)) return r;
  }
  return null;
}

// Generates the punchy, human <5-line cold email to the founder.
export function heuristicPitch(company, events, contact = null) {
  const cfg = getConfig();
  const cand = cfg.candidate || {};
  const f = events.find((e) => e.type === 'funding');
  const dir = events.find((e) => e.type === 'directory');
  const h = events.find((e) => e.type === 'hiring');

  const founderName = contact?.name ? contact.name.split(/\s+/)[0] : 'there';
  const roleName = cand.targetRoles?.[0] || 'software engineer';

  // 1. Hook
  let hook;
  const latestTrigger = events.find(e => ['funding', 'hiring', 'directory'].includes(e.type));
  if (latestTrigger?.type === 'hiring') {
    hook = `I saw your hiring post, “${h.title}”, and wanted to ask about joining ${company.name}.`;
  } else if (f) {
    const amt = f.amount_usd_m ? fmtUsdM(f.amount_usd_m) : f.amount_text || '';
    hook = `Saw that ${company.name} just raised a ${f.stage || 'funding'} round${amt ? ` (${amt})` : ''} — huge congratulations!`;
  } else if (dir) {
    hook = `Saw ${company.name} is part of Y Combinator — big congrats on the launch!`;
  } else {
    hook = `Came across ${company.name} recently and was really impressed by what your team is building.`;
  }

  // 2. Value + Proof
  const skillsStr = (cand.skills || ['TypeScript', 'React', 'Node.js']).slice(0, 3).join(', ');
  const links = [cand.portfolioUrl && `Portfolio: ${cand.portfolioUrl}`, cand.githubUrl && `GitHub: ${cand.githubUrl}`].filter(Boolean).join(' | ');
  const value = `I'm interested in ${latestTrigger?.type === 'hiring' ? 'this opening' : roleName.toLowerCase() + ' opportunities'} and work primarily with ${skillsStr}. I build fast, scalable web apps and love early-stage teams where speed matters.`;
  const proof = links ? `Quick proof of work: ${links}` : '';

  // 3. CTA
  const cta = `Would you be open to a quick 10-minute chat this week to see if I'd be a strong fit for your team?`;

  const lines = [
    `Hi ${founderName},`,
    '',
    hook,
    '',
    value,
    proof ? '' : null,
    proof || null,
    '',
    cta,
    '',
    `Best,\n${cand.name || 'Candidate'}`
  ].filter((x) => x !== null);
  const subject = latestTrigger?.type === 'hiring' ? `your opening at ${company.name}` : f ? `congrats on the ${f.stage || 'funding'} round / ${roleName.toLowerCase()}` : `engineer interested in ${company.name}`;

  return { subject, body: lines.join('\n') };
}

async function llmPitch(company, events, enr, contact) {
  const cfg = getConfig();
  const cand = cfg.candidate || {};
  const facts = {
    company: company.name,
    sector: company.sector,
    description: company.description,
    founder: contact ? { name: contact.name, role: contact.role } : null,
    funding: events.find((e) => e.type === 'funding' || e.type === 'directory'),
    techStack: enr?.techStack || [],
    candidate: {
      name: cand.name,
      role: cand.targetRoles?.[0] || 'Full Stack Engineer',
      skills: cand.skills || [],
      portfolio: cand.portfolioUrl,
      github: cand.githubUrl,
      experience: cand.experience,
    },
  };

  const system = `You write short, human cold emails from a software engineer directly to startup founders who just raised funding or are hiring.
STRICT RULES:
1. Maximum 4 to 5 lines of body text. Never long, verbose paragraphs.
2. NO corporate clichés: do NOT use "I hope this email finds you well", "I was thrilled to read", "prestigious company".
3. Hook: Reference their exact trigger (recent seed round, YC batch, or hiring post).
4. Value: State the engineer's core stack and how they can build features fast without onboarding friction.
5. Frictionless CTA: "Open to a quick 10-min chat this week?"
6. Subject line must be lower-case, natural, and intriguing (e.g. "junior backend role" or "saw your seed round - quick question").`;

  const prompt = `Facts:\n${JSON.stringify(facts, null, 1)}\n\nWrite a 4-5 line human cold email. Return JSON: {"subject": "...", "body": "..."}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      subject: { type: 'STRING' },
      body: { type: 'STRING' },
    },
    required: ['subject', 'body'],
  };

  return llm.json(system, prompt, schema, { temperature: 0.3, maxTokens: 400 });
}

export async function enrichCompany(id) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', id);
  if (!c) return null;
  const events = q.all('SELECT * FROM events WHERE company_id = ? ORDER BY occurred_at DESC', id);
  let enr = { checkedAt: nowIso(), found: false, techStack: [] };
  let site = null;

  try {
    site = await findWebsite(c);
    if (site) {
      const a = analyse(site.html, site.url);
      enr = { ...enr, found: true, url: site.url, domain: domainOf(site.url), ...a };
      delete enr.textSample;
    }
  } catch (e) {
    enr.error = e.message;
  }

  // Research decision makers and leadership team
  let peopleResult = null;
  try {
    peopleResult = await researchPeople(id, { siteHtml: site?.html, siteUrl: site?.url });
    if (peopleResult?.openRoles) enr.openRoles = peopleResult.openRoles;
  } catch (e) {
    log('error', `People research for ${c.name}: ${e.message}`);
  }

  // Pick primary contact (Founder / CTO / CEO)
  const primaryContact = q.get(`SELECT * FROM contacts WHERE company_id = ? AND do_not_contact = 0 ORDER BY
    CASE
      WHEN role LIKE '%CTO%' OR role LIKE '%Technology%' THEN 1
      WHEN role LIKE '%Founder%' OR role LIKE '%Co-founder%' THEN 2
      WHEN role LIKE '%CEO%' THEN 3
      ELSE 4
    END, id ASC LIMIT 1`, id);

  // Generate 5-line cold email draft
  let emailDraft = null;
  if (llm.available()) {
    try {
      emailDraft = await llmPitch(c, events, enr, primaryContact);
    } catch { /* fallback below */ }
  }
  if (!emailDraft?.body) {
    emailDraft = heuristicPitch(c, events, primaryContact);
  }

  const domain = enr.domain && !q.get('SELECT id FROM companies WHERE domain = ? AND id != ?', enr.domain, id) ? enr.domain : c.domain;

  q.run(`UPDATE companies SET enrichment = ?, enriched_at = ?, pitch = ?, pitch_subject = ?,
    tech_stack = ?, website = COALESCE(?, website), domain = ?, description = COALESCE(description, ?), updated_at = ? WHERE id = ?`,
    JSON.stringify(enr), nowIso(), emailDraft.body, emailDraft.subject,
    JSON.stringify(enr.techStack || []), enr.found ? enr.url : null, domain, enr.description || null, nowIso(), id);

  log('enrich', `${c.name}: ${enr.found ? `${enr.domain} · Tech: ${enr.techStack.join(', ') || 'modern web'} · Email drafted` : 'website not found'}`);
  return enr;
}
