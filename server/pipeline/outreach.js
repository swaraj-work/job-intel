import { fmtUsdM } from '../util/text.js';

export function outreachDraft(company, events, candidate, contact, template = 'suggested') {
  const funding = events.find(event => event.type === 'funding');
  const hiring = events.find(event => event.type === 'hiring');
  if (template === 'suggested') {
    const signal = events.find(event => ['funding', 'hiring'].includes(event.type));
    template = signal?.type || 'intro';
  }

  const name = contact?.name?.trim().split(/\s+/)[0] || 'there';
  const role = candidate.targetRoles?.[0] || 'software engineering';
  const links = [candidate.portfolioUrl && `Portfolio: ${candidate.portfolioUrl}`,
    candidate.githubUrl && `GitHub: ${candidate.githubUrl}`].filter(Boolean).join(' | ');
  const skills = candidate.skills?.slice(0, 3).join(', ');
  const pitch = candidate.oneLinerPitch?.trim() || (skills ? `I work with ${skills}.` : '');
  let subject, opening, ask;

  switch (template) {
    case 'hiring':
      if (!hiring) return null;
      subject = `Engineering opening at ${company.name}`;
      opening = `I saw “${hiring.title}” and wanted to introduce myself as a candidate.`;
      ask = 'Would you be open to a quick chat about the role?';
      break;
    case 'funding': {
      if (!funding) return null;
      const amount = funding.amount_usd_m ? fmtUsdM(funding.amount_usd_m) : funding.amount_text;
      subject = `Congrats on the round, ${company.name}`;
      opening = `Congrats to the ${company.name} team on the ${funding.stage || 'funding'} round${amount ? ` (${amount})` : ''}. I’m interested in ${role} opportunities as you grow.`;
      ask = 'Are you planning any engineering hires in the coming months?';
      break;
    }
    case 'follow-up':
      subject = `Following up on ${role} at ${company.name}`;
      opening = `I wanted to follow up on my note about ${role} opportunities at ${company.name}.`;
      ask = 'If you’re hiring, would a short chat next week be useful?';
      break;
    case 'intro':
      subject = `${role} opportunities at ${company.name}`;
      opening = `I’m reaching out to ask about ${role} opportunities at ${company.name}.`;
      ask = 'Are there any openings where my background might fit?';
      break;
    default:
      return null;
  }

  return {
    subject: subject.replace(/[\x00-\x1f\x7f]+/g, ' '),
    body: [`Hi ${name},`, opening, template === 'follow-up' ? '' : pitch, links, ask,
      candidate.name ? `Best,\n${candidate.name}` : 'Thanks!'].filter(Boolean).join('\n\n'),
  };
}
