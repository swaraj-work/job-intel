import { q, J, nowIso, getSetting } from '../db.js';
import { getConfig } from '../config.js';
import { daysAgo, fmtUsdM } from '../util/text.js';
import { isEnterpriseName } from './extract.js';

const STAGE_LATE = /series [c-z]|pre-ipo|ipo/i;

// Transparent, candidate-focused job opportunity scoring.
// Based on the early-stage hiring playbook: Seed/Pre-seed funding + small team + tech stack match.
export function computeScore(company, events, cfg = getConfig(), learned = getSetting('learned', {})) {
  const W = cfg.weights;
  const P = cfg.penalties;
  const parts = [];
  const add = (key, label, frac, detail) => {
    const pts = Math.round((W[key] || 0) * Math.max(0, Math.min(1, frac)));
    parts.push({ key, label, points: pts, max: W[key] || 0, detail });
  };
  const enr = J(company.enrichment, null);
  const techStack = J(company.tech_stack, enr?.techStack || []);
  const allText = [company.description, ...events.map((e) => `${e.title} ${e.summary || ''} ${J(e.signals, []).join(' ')}`)].join(' ');

  // 1. Funding: recent Pre-seed, Seed, Angel, Series A
  const fundings = events.filter((e) => e.type === 'funding' || e.type === 'directory');
  let fBest = 0, fDetail = 'No funding signal yet';
  for (const e of fundings) {
    const age = Math.max(0, daysAgo(e.occurred_at));
    const recency = Math.pow(0.5, age / (cfg.recencyHalfLifeDays || 14));
    const stageF = !e.stage ? 0.7 : cfg.preferredStages.includes(e.stage) ? 1 : cfg.okStages.includes(e.stage) ? 0.7 : STAGE_LATE.test(e.stage) ? 0.3 : 0.5;
    const a = e.amount_usd_m;
    const amtF = a == null ? 0.8 : a < 0.2 ? 0.7 : a > 20 ? 0.6 : 1;
    const typeF = e.type === 'directory' ? 0.85 : 1;
    const f = recency * stageF * amtF * typeF;
    if (f > fBest) {
      fBest = f;
      fDetail = `${e.stage || 'Round'}${a ? ` (${fmtUsdM(a)})` : ''} · ${Math.round(age)}d ago`;
    }
  }
  add('funding', 'Seed / Early Funding', fBest, fDetail);

  // 2. Hiring Signal: explicit "hiring" posts, open engineering jobs, YC hiring badge
  const hiringEvents = events.filter((e) => e.type === 'hiring' || /hiring|careers|opening/i.test(e.title));
  const hasAts = Boolean(enr?.openRoles?.count > 0);
  const hiringKeywords = (cfg.keywords?.hiring || []).filter((k) => new RegExp(`\\b${k}\\b`, 'i').test(allText));
  let hScore = 0, hDetail = 'No explicit hiring post yet';
  if (hiringEvents.length || hasAts) {
    hScore = 1;
    hDetail = hasAts ? `${enr.openRoles.count} open roles on careers page` : 'Active hiring announcement';
  } else if (hiringKeywords.length) {
    hScore = 0.75;
    hDetail = `Mentioned: ${hiringKeywords.slice(0, 2).join(', ')}`;
  } else if (fBest > 0.4) {
    // Startups that just raised capital start hiring immediately
    hScore = 0.6;
    hDetail = 'Fresh funding = immediate hiring expansion';
  }
  add('hiringSignal', 'Hiring Signal', hScore, hDetail);

  // 3. Small Team Size: <= 50 people is ideal (founders hire directly, no HR bureaucracy)
  const team = J(company.team, null);
  const teamSize = team?.exact ? team.min : team ? Math.round(Math.sqrt(team.min * team.max)) : null;
  let teamScore = 0.5, teamDetail = 'Estimated team size';
  if (teamSize != null) {
    if (teamSize <= 25) { teamScore = 1.0; teamDetail = `~${teamSize} people: founders hire directly`; }
    else if (teamSize <= 60) { teamScore = 0.9; teamDetail = `~${teamSize} people: small eng team`; }
    else if (teamSize <= 150) { teamScore = 0.65; teamDetail = `~${teamSize} people: CTO / VP Eng hires`; }
    else { teamScore = 0.3; teamDetail = `~${teamSize} people: larger organization`; }
  } else if (fBest > 0.5) {
    teamScore = 0.8;
    teamDetail = 'Early stage: likely < 30 people';
  }
  add('smallTeam', 'Founder Hiring Access', teamScore, teamDetail);

  // 4. Tech Stack Match: overlap with candidate skills
  const candidateSkills = cfg.candidate?.skills || ['JavaScript', 'TypeScript', 'Node.js', 'React', 'Python'];
  const matchedSkills = candidateSkills.filter((s) => {
    const re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return techStack.some((t) => re.test(t)) || re.test(allText);
  });
  const techScore = matchedSkills.length >= 3 ? 1.0 : matchedSkills.length >= 2 ? 0.8 : matchedSkills.length === 1 ? 0.5 : 0.2;
  add('techMatch', 'Tech Stack Match', techScore, matchedSkills.length ? `Matches: ${matchedSkills.slice(0, 4).join(', ')}` : 'General modern stack');

  // 5. Recency: speed is everything (Reddit rule: first 100 applicants win)
  const firstSeenDays = daysAgo(company.first_seen_at);
  const recencyScore = firstSeenDays < 2 ? 1.0 : firstSeenDays < 4 ? 0.8 : firstSeenDays < 8 ? 0.5 : 0.2;
  add('recency', 'Opportunity Freshness', recencyScore, firstSeenDays < 1 ? 'Discovered today (<24h)' : `First seen ${Math.round(firstSeenDays)}d ago`);

  // 6. Has Verified Email: founder or CTO email ready
  const contacts = q.all('SELECT email, role FROM contacts WHERE company_id = ? AND email IS NOT NULL', company.id);
  const hasEmail = contacts.length > 0;
  add('hasEmail', 'Contact Email Ready', hasEmail ? 1 : 0, hasEmail ? `Found ${contacts.length} verified contact(s)` : 'Email lookup pending');

  // Penalties
  if (company.size === 'enterprise' || isEnterpriseName(company.name, cfg)) {
    parts.push({ key: 'enterprise', label: 'Large enterprise', points: P.enterprise, max: 0, detail: 'Enterprise HR screening gate' });
  }
  if (fundings.some((e) => STAGE_LATE.test(e.stage || ''))) {
    parts.push({ key: 'lateStage', label: 'Late stage', points: P.lateStage, max: 0, detail: 'Late stage: heavy applicant volume' });
  }
  const neg = (cfg.keywords?.negative || []).filter((k) => new RegExp(`\\b${k}\\b`, 'i').test(allText));
  if (neg.length) {
    parts.push({ key: 'negativeNews', label: 'Negative news', points: P.negativeNews, max: 0, detail: neg.join(', ') });
  }

  let total = parts.reduce((s, p) => s + p.points, 0);
  const conf = Math.max(0.5, Math.min(1, company.confidence || 0.6));
  total = Math.round(Math.max(0, Math.min(100, total * (0.8 + 0.2 * conf))));
  return { score: total, breakdown: parts, why: explain(company, events, parts, matchedSkills) };
}

function explain(company, events, parts, matchedSkills) {
  const f = events.find((e) => e.type === 'funding') || events.find((e) => e.type === 'directory');
  const h = events.find((e) => e.type === 'hiring');
  const team = J(company.team, null);
  const triggers = [];
  if (f?.type === 'funding') {
    triggers.push(`raised ${f.stage || 'new funding'}${f.amount_usd_m ? ` of ${fmtUsdM(f.amount_usd_m)}` : ''}${f.occurred_at ? ` ${Math.max(0, Math.round(daysAgo(f.occurred_at)))}d ago` : ''}`);
  } else if (f?.type === 'directory') {
    triggers.push('is a Y Combinator-backed startup');
  }
  if (h) {
    triggers.push('actively hiring developers');
  }
  const tStr = team ? `~${team.exact ? team.min : `${team.min}-${team.max}`} team` : 'early team';
  const matchStr = matchedSkills?.length ? `Stack match: ${matchedSkills.slice(0, 3).join(', ')}` : null;
  const lead = triggers.length ? `${company.name} ${triggers.join(' and ')} (${tStr}).` : `${company.name} is expanding its engineering team (${tStr}).`;
  return matchStr ? `${lead} ${matchStr}.` : lead;
}

export function rescore(companyId) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  const events = q.all('SELECT * FROM events WHERE company_id = ? ORDER BY occurred_at DESC', companyId);
  const { score, breakdown, why } = computeScore(c, events);
  q.run('UPDATE companies SET score = ?, breakdown = ?, why = ?, updated_at = ? WHERE id = ?', score, JSON.stringify(breakdown), why, nowIso(), companyId);
  return score;
}

export function rescoreAll() {
  const all = q.all('SELECT id FROM companies');
  for (const { id } of all) rescore(id);
}
