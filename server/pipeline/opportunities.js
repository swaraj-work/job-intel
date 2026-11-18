// Rules are shared by discovery, the posting inbox and deterministic company extraction.
const rolePatterns = [
  ['AI engineering', /\b(?:AI|ML|AI\/ML|machine learning|artificial intelligence|LLM|GenAI)[ -]+(?:software )?(?:engineer\w*|develop\w*|intern\w*)\b/i],
  ['Backend', /\bback[ -]?end\b/i],
  ['Full stack', /\bfull[ -]?stack\b/i],
  ['Software engineering', /\b(?:SDE|SWE)(?:[- ]?(?:[123]|I{1,3}))?\b|\bsoftware (?:development |engineering )?(?:engineer\w*|developer|intern\w*)\b/i],
];
const india = /\b(?:india|indian|bengaluru|bangalore|mumbai|pune|delhi|ncr|noida|gurugram|gurgaon|hyderabad|chennai|kolkata|kochi|ahmedabad|chandigarh|jaipur|karnataka|inr)\b|₹/i;
const seeker = /\b(?:for hire|looking for (?:an? |my |entry.level |junior )*(?:job|internship|opportunit(?:y|ies))|seeking (?:a |an? )?(?:job|internship|opportunit(?:y|ies))|open to work|need a referral|resume review|job hunt|interview experience|hiring freeze|not hiring)\b/i;
const hiring = /\b(?:hiring|we(?:'re| are) looking for|join our team|open(?:ing| position| role)s?|apply (?:here|now|at)|vacanc(?:y|ies)|recruiting)\b/i;

export function matchOpening(item, source) {
  const job = item.meta?.job;
  const title = item.title || '';
  const text = title + ' ' + (item.summary || '');
  const roleText = job ? title + ' ' + (job.specialty || '') : text;
  const role = rolePatterns.find(([, pattern]) => pattern.test(roleText))?.[0];
  const startup = source.kind === 'ycjobs' ? 'YC startup' : source.kind === 'ashby' && source.id?.startsWith('ashby-') ? 'Tracked startup'
    : /\b(?:startup|start-up|seed[- ]stage|pre-seed|YC [WSFX]\d{2})\b/i.test(text) ? 'Startup mentioned' : null;
  if (!role || (!job && (seeker.test(text) || !(item.meta?.hiringThread || hiring.test(text))))) return null;
  if (/\b(?:sr\.?|senior|staff|principal|lead|manager|architect|head of|SDE[- ]?(?:II+|[23])|(?:engineer|developer) (?:II+|[23]))\b/i.test(title)) return null;
  if (!job && /\b(?:hiring|seeking|looking for)\s+(?:an?\s+)?(?:senior|staff|principal|lead)\b/i.test(text)) return null;
  const requirementText = [title, job?.experience, item.summary].filter(Boolean).join(' ');
  const years = [...requirementText.matchAll(/\b(\d{1,2})(?:\s*[-–—]\s*\d+)?\+?\s*(?:years?|yrs?)\b(?:\s+(?:of\s+)?(?:professional |industry |relevant |work |software |development |engineering )*experience)?/gi)]
    .filter(m => /experience/i.test(m[0]) || title.includes(m[0]) || job?.experience?.includes(m[0]) || /\+|[-–—]/.test(m[0]) || /(?:minimum|at least|requires?|experience[: ]+)\s*$/i.test(requirementText.slice(0, m.index)));
  if (years.some(m => Number(m[1]) > 2)) return null;
  const geo = job?.location || text;
  const local = india.test(geo) || /(?:^|[(/,; ])IN(?:$|[)/,; ])/.test(job?.location || '');
  const foreign = /\b(?:US|UK|EU)\b/.test(geo) || /\b(?:USA|Canada|Europe|EMEA|United States|United Kingdom|San Francisco|New York|London)\b/i.test(geo);
  if (!local && foreign) return null;
  if (!local && !/\b(?:remote|worldwide|anywhere)\b/i.test(geo) && !source.params?.assumeIndia && !(source.kind === 'reader' && !job?.location)
    && !/india|bangalore|bengaluru/i.test(source.params?.sub || '')) return null;
  const intern = /\bintern(?:ship)?s?\b/i.test(job ? title + ' ' + (job.employment || '') : text);
  const early = /\b(?:associate|junior|jr|fresher\w*|new grad\w*|entry[ -]level|graduate|SDE[- ]?(?:1|I)|engineer I)\b/i.test(requirementText);
  return { role, startup, level: intern ? 'Internship' : early || years.length ? 'Early career' : 'Experience unspecified',
    experience: job?.experience || years[0]?.[0] || null,
    location: job?.location || (local ? 'India mentioned' : 'Check location'), company: job?.company || null };
}

export function fundingSignal(title) {
  return /\b(?:raises?|raised|secures?|secured|bags?|closes?|lands?|nets?|mops up|snags?)\b.{0,85}(?:\$|₹|\b(?:rs\.?|crore|million|seed|series [a-c]|funding|investment|round)\b)/i.test(title)
    && !/\b(?:aims? to|plans? to|in talks to|seeks? to|to raise|fund [IVX]+|launches? (?:a |an? )?fund|weekly roundup)\b/i.test(title);
}
