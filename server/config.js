import { getSetting, setSetting } from './db.js';

// Configuration for Candidate Outbound Engine (JobIntel)
// Based on the 20-emails/day cold outreach strategy targeting Seed/Pre-Seed startups & fresh hiring posts.
export const DEFAULT_CONFIG = {
  candidate: {
    name: '',
    targetRoles: [
      'AI Engineer',
      'Full Stack Developer',
      'Backend Engineer',
      'SDE I',
      'Software Engineer',
      'Software Engineering Intern'
    ],
    skills: [
      'JavaScript', 'TypeScript', 'Node.js', 'React', 'Next.js',
      'Python', 'PostgreSQL', 'FastAPI', 'Docker', 'Tailwind', 'REST APIs'
    ],
    experience: '0-2 years / Fresher',
    location: 'Bangalore / Remote',
    portfolioUrl: '',
    githubUrl: '',
    linkedinUrl: '',
    resumeUrl: '',
    dailyEmailTarget: 20,
    oneLinerPitch: ''
  },
  threshold: 55, // Cut-off for high-probability target in the Daily 20
  dailyQuota: 20, // Daily target of 20 personalized emails
  weights: {
    funding: 30,       // Pre-Seed, Seed, Angel, Series A (immediate capital to hire)
    hiringSignal: 25,  // "we're hiring", active engineering posts, YC hiring tag
    smallTeam: 20,     // Headcount <= 50 (founder direct hires, fast decisions without HR red tape)
    techMatch: 15,     // Detected tech stack overlaps with candidate skills
    recency: 10,       // Announced/posted in the last 48 hours (first 100 applicants rule)
    hasEmail: 5,       // Verified founder/CTO work email available
  },
  penalties: {
    enterprise: -30,       // Large conglomerates with HR gatekeepers (TCS, Infosys, etc.)
    lateStage: -15,        // Series D+ / pre-IPO (hundreds of applicants per role)
    negativeNews: -25,     // Layoffs, shutdowns, insolvency
    nonTech: -60,          // Food, restaurant, offline retail, non-tech businesses
  },
  preferredStages: ['Pre-Seed', 'Angel', 'Seed', 'Pre-Series A', 'Series A'],
  okStages: ['Series B', 'Grant', 'Bootstrapped'],
  fundingSweetSpotUsdM: { min: 0.2, max: 20 },
  recencyHalfLifeDays: 14,
  sectors: {
    'AI': 1.0, 'SaaS': 1.0, 'DevTools': 1.0, 'Fintech': 0.95, 'Healthtech': 0.85,
    'Edtech': 0.8, 'E-commerce': 0.8, 'Gaming': 0.8, 'Logistics': 0.75, 'Other': 0.3,
    'F&B': 0.0, 'Retail & D2C': 0.1, 'Real Estate': 0.0, 'Agency': 0.2
  },
  keywords: {
    hiring: [
      'we are hiring', "we're hiring", 'hiring', 'looking for', 'founding engineer',
      'full stack', 'backend', 'frontend', 'software engineer', 'developer', 'join us',
      'building our team', 'grow the team', 'careers', 'opening', 'co-founder'
    ],
    tech: [
      'react', 'next.js', 'node', 'nodejs', 'typescript', 'javascript', 'python',
      'fastapi', 'django', 'postgres', 'postgresql', 'mongodb', 'docker', 'aws',
      'tailwind', 'graphql', 'redis', 'ai', 'llm'
    ],
    negative: ['layoffs', 'shuts down', 'shutdown', 'insolvency', 'bankruptcy', 'fraud', 'raid', 'winds up', 'firing']
  },
  enterpriseNames: [
    'Reliance', 'Tata', 'Infosys', 'Wipro', 'HCL', 'TCS', 'Adani', 'Mahindra', 'Flipkart', 'Paytm',
    'Zomato', 'Swiggy', 'Ola', 'Byju', 'Bharti', 'Airtel', 'Jio', 'HDFC', 'ICICI', 'SBI', 'Axis', 'Kotak', 'Bajaj', 'Birla',
    'Vedanta', 'ITC', 'Hindustan Unilever', 'Larsen', 'L&T', 'Nykaa', 'PhonePe', 'Meesho', 'Zepto'
  ],
  competitors: [],
  blocklist: [
    'Inc42', 'YourStory', 'Entrackr', 'TechCrunch', 'Economic Times', 'Moneycontrol', 'Mint', 'Reuters', 'Bloomberg',
    'Peak XV', 'Sequoia', 'Accel', 'Blume', 'Blume Ventures', 'Nexus', 'Elevation', 'Lightspeed', 'Matrix Partners', 'Kalaari',
    'Chiratae', 'Stellaris', '3one4', 'Info Edge', 'Tiger Global', 'SoftBank', 'Y Combinator', 'RBI', 'SEBI',
    'Government', 'Centre', 'India', 'Startup', 'Startups', 'Google', 'Microsoft', 'Amazon', 'Meta', 'Apple', 'OpenAI'
  ],
  brief: { size: 20, explorationShare: 0.15 },
  llm: {
    batchSize: 8,
    dailyCallCap: 300,
    minIntervalMs: 6500,
  },
  enrichment: { minScore: 40, perCycle: 4 },
  contacts: {
    smallTeamMax: 50,          // up to 50: target Founder / Co-Founder / CEO / CTO
    midTeamMax: 200,           // 51-200: target CTO / VP Engineering / Head of Product
    emailProvider: 'auto',     // auto | sprouts | apollo | hunter
    monthlyLookupCap: 200,     // paid email lookups per month
    autoFindEmailMinScore: 0, // auto find email for top scoring targets
  },
  agent: { enabled: false, intervalMinutes: 120, queriesPerCycle: 3, queryTtlDays: 4 },
  maxItemAgeDays: 30,
};

export function getConfig() {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), getSetting('config', {}));
  cfg.agent.queriesPerCycle = Math.max(1, Math.min(8, Math.floor(cfg.agent.queriesPerCycle)));
  cfg.enrichment.perCycle = Math.max(1, Math.min(8, Math.floor(cfg.enrichment.perCycle)));
  cfg.llm.batchSize = Math.max(1, Math.min(20, Math.floor(cfg.llm.batchSize)));
  return cfg;
}

export function saveConfig(next) {
  setSetting('config', next);
  return getConfig();
}

export function resetConfig() {
  return saveConfig({});
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  for (const [k, v] of Object.entries(over)) {
    if (!Object.hasOwn(base, k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === null || Array.isArray(v) !== Array.isArray(base[k]) || typeof v !== typeof base[k]) continue;
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : Array.isArray(v) ? v.filter(item => typeof item === 'string').slice(0, 100).map(item => item.slice(0, 300))
        : typeof v === 'string' ? v.slice(0, 1000) : v;
  }
  return base;
}
