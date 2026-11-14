// Cheap regex gate in front of the LLM. Drops roughly 80-90% of items.
import { classifyIntel, classifyReddit } from './intel.js';

const RE = {
  india: /\b(india|indian|bharat|bengaluru|bangalore|mumbai|delhi|ncr|gurugram|gurgaon|noida|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|surat|kochi|chandigarh|indore|coimbatore|lucknow|remote)\b|₹|\b(crore|lakh)s?\b|\brs\.?\s?\d|\binr\b/i,
  funding: /\b(raises?|raised|raising|secures?|secured|bags?|bagged|lands?|nets?|mops? up|closes?|funding|funded|seed|pre-seed|angel round|series [a-f]|pre-series|investment|invests?|backed|led by|valuation|debt round|bridge round)\b/i,
  hiring: /\b(we('re| are) hiring|hiring\b|hires?\b|looking for\b|founding engineer|software engineer|full[- ]?stack|frontend|backend|developer|devops|data engineer|ai engineer|machine learning|designer|internship|interns?\b|open roles|join (our|the) team|careers|we need a|co-founder)\b/i,
  expansion: /\b(expands?|expanding|expansion|enters?|entry into|forays?|launch(es|ed)? in|global|globally|international|overseas|abroad|us market|uk market|united states|america|uae|dubai|saudi|middle east|europe|singapore)\b/i,
  launch: /\b(launch(es|ed)?|unveils?|introduces?|rolls out|partners? with|partnership|acquires?|acquisition|show hn|product hunt)\b/i,
  noise: /\b(sensex|nifty|share price|stock(s)? (to buy|rally|fall)|q[1-4] (results|earnings)|quarterly results|ipo (gmp|subscription|allotment)|horoscope|cricket|bollywood|box office|recipe|weather|election|monsoon)\b/i,
};

export function prefilter(item, source) {
  const text = `${item.title} ${item.summary || ''}`;
  const hits = {};
  for (const [k, re] of Object.entries(RE)) hits[k] = re.test(text);

  if (item.meta?.entity) return { pass: true, route: 'structured', hits };

  const cat = source.category;
  if (cat === 'voice') {
    const cls = classifyReddit(item, source);
    return { pass: !!cls, route: 'voice', cls, reason: cls ? null : 'not an active hiring or startup post', hits };
  }

  if (hits.noise && !hits.funding && !hits.hiring) return { pass: false, reason: 'market noise', hits };

  const india = hits.india || source.params?.assumeIndia || /^(inc42|entrackr|yourstory|et-startups)/.test(source.id);
  const intent = hits.funding || hits.hiring || hits.launch || hits.expansion;
  if (!intent) return { pass: false, reason: 'no funding or hiring signal', hits };
  if (!india && source.kind !== 'hn' && source.kind !== 'yc') return { pass: false, reason: 'no India/Remote signal', hits };
  return { pass: true, route: 'leads', hits };
}
