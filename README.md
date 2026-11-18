# JobIntel · Automated Founder Outreach & Job Discovery Engine

> **The 2026 Startup Job-Hunting Playbook as Code**
> 
> Inspired by the viral strategy: *"Stop applying to job boards where 1,000+ applicants sit in HR queues. Instead, track fresh Seed rounds and early 'we're hiring' posts (< 24h old, < 100 likes). Find the founder/CTO's direct work email, send a punchy < 5-line cold email, and hit 20 emails a day."*

JobIntel transforms this strategy into a 24/7 autonomous outbound engine. It continuously tracks Seed, Pre-Seed, and Series A funding rounds across tech publications, Google News, Y Combinator, and developer subreddits. It pinpoints early-stage startups ($\le 50$ people) where founders make hiring decisions directly, discovers verified founder/CTO work emails, matches their tech stack to your candidate profile, crafts human-sounding < 5-line cold email drafts, and manages your daily 20-email outbound pipeline.

---

## The 20-Emails-A-Day Strategy

```
1. Fresh Signals Early       2. Direct to Founders          3. < 5-Line Human Drafts       4. Hit 20 Emails/Day
───────────────────────      ─────────────────────          ────────────────────────       ───────────────────
Track Seed funding rounds    Target CTOs, Technical         No generic AI essays.          Daily flame counter,
and "we're hiring" posts     Co-founders & Founders         Short, punchy, specific       one-click "Open in Gmail",
< 24h old before job boards  (teams <= 50 where founders    to their funding event         and pipeline status
get flooded.                 hire directly without HR).     and your core stack.           tracking.
```

---

## Key Features

1. **Daily 20 Target Brief**: Curated batch of the top 20 startup opportunities each morning, ranked by opportunity score and recency.
2. **5-Line Cold Outreach Cockpit**:
   - Auto-generates personalized cold emails under 5 lines referencing the startup's funding announcement or hiring signal.
   - One-click **"✉ Open in Gmail"** pre-fills the verified founder email, subject, and body.
   - **"✓ Mark as Sent"** logs your progress toward the daily 20 quota with live counter feedback.
3. **Founder & Decision-Maker Intelligence**:
   - Automatically prioritizes CTO, Technical Co-founder, Founder, and CEO for engineering candidates.
   - Integrates with Apollo and Hunter to fetch verified business emails with deliverability status checks.
4. **Candidate Profile Engine**:
   - Configure your target roles (e.g. *Founding Engineer*, *Full Stack Developer*), core tech stack (*React*, *Node.js*, *Python*, *PostgreSQL*), portfolio, GitHub, and one-liner pitch.
   - All cold email drafts dynamically weave in your actual portfolio links and relevant experience.
5. **Tech Stack & ATS Detection**:
   - Inspects startup websites to detect frontend, backend, database, and cloud technologies.
   - Identifies whether the company uses Greenhouse, Lever, or Ashby, or relies on direct founder outreach.
6. **Reddit Hiring Inbox**:
   - Ingests developer and startup subreddits (`r/developersIndia`, `r/IndianStartups`, `r/remotejobs`, etc.).
   - Triages fresh hiring posts with keyboard shortcuts (`J`/`K` navigation, `O` open, `R` outreach sent).
7. **Application Pipeline Tracker**:
   - Track applications across stages: *To Reach Out*, *Email Sent*, *Replied*, *Interviewing*, *Offer Received*, and *Rejected*.
   - Filter by tech match, funding stage, recency, or keyword.
   - Export pipeline to CSV anytime.

---

## Quick Start

### 1. Requirements
- Node.js 22.5+ (uses native `node:sqlite` in WAL mode; no native build tools required)

### 2. Setup
```bash
git clone <repo>
cd pg-intel
npm install
```

### 3. Environment Variables (Optional)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Key configuration options:
- `PORT`: Server port (default: `4300`)
- `GROQ_API_KEY` or `GEMINI_API_KEY`: Enables LLM extraction and bespoke email personalization (if omitted, high-speed heuristic rules run with zero cost).
- `APOLLO_API_KEY` or `HUNTER_API_KEY`: Enables automatic verified founder work email lookups.
- `AUTH_USERNAME` and `AUTH_PASSWORD` configure sign-in. Both default to `admin` when blank. Set a private password in Railway's service variables before exposing real lead data.
- `SESSION_SECRET` can be set to a random secret to keep sessions valid across restarts.

### 4. Run the Engine
```bash
npm start
```
Open [http://localhost:4300](http://localhost:4300) in your browser.

If Railway's install step reports the npm production config warning, remove `NPM_CONFIG_PRODUCTION` from the service variables and use `NPM_CONFIG_OMIT=dev` for production-only installs.

---

## Scoring Model (Opportunity Fit)

Every company is evaluated against a 100-point opportunity scoring model:

| Factor | Weight | What it Evaluates |
| :--- | :--- | :--- |
| **Seed / Early Funding** | 30 pts | Recent Pre-Seed, Seed, Angel, or Series A funding (fresh capital deployed for hiring). |
| **Hiring Signal** | 25 pts | Explicit hiring announcement, "founding engineer" mention, or active developer job posts. |
| **Small Team** | 15 pts | Headcount $\le 50$. Founders make direct hiring decisions without HR friction. |
| **Tech Stack Match** | 15 pts | Company's tech stack (React, Node, Python, Postgres, etc.) matches candidate's core skills. |
| **Recency** | 10 pts | Signal discovered within the last 24–48 hours. Speed is everything. |
| **Verified Email** | 10 pts | Verified founder work email readily available for instant outreach. |
| **Novelty** | 5 pts | Freshly discovered startup opportunity. |

*Weights and thresholds can be tuned live in the **Profile & Config** tab.*

---

## 5-Line Cold Email Template

The engine generates short, direct, human-written emails following the viral Reddit formula:

```text
Subject: Congrats on the Seed round / founding engineer at [Startup]

Hi [Founder Name],

Saw [Startup]'s recent Seed round led by [Investor]—huge congratulations on the milestone.

I'm a full-stack engineer with hands-on experience building fast web apps with React, Node.js, and PostgreSQL. I love working at the early stage where speed and ownership matter most.

Built a few projects here: [Portfolio URL] / [GitHub URL].

Would love to help you build out the core product. Open to a quick 10-min chat this week?

Best,
[Your Name]
```

---

## Architecture

```
[News Feeds / Google News / YC / Reddit / HN]
                   │
                   ▼
      [Prefilter Regex Gate] (Drops non-hiring & corporate noise)
                   │
                   ▼
         [Entity Resolution] (Deduplicates companies & merges events)
                   │
                   ▼
      [Opportunity Scoring Engine] (Seed stage + small team + tech match)
                   │
                   ▼
   [Webpage Enrichment & Tech Stack] (Detects frameworks, libraries, ATS)
                   │
                   ▼
     [Founder & Decision Maker Plan] (CTO / Founder targeting)
                   │
                   ▼
     [Apollo / Hunter Email Finder] (Verified work email discovery)
                   │
                   ▼
       [5-Line Cold Email Draft] (Direct personalized pitch)
                   │
                   ▼
       [Daily 20 Outbound Cockpit] (Gmail integration & quota tracker)
```

---

## Ethical & Privacy Guardrails
- **No Scraping Gated Networks**: We never scrape LinkedIn profiles or private directories. Links to LinkedIn searches allow the user to review public profiles directly.
- **Verified Business Emails Only**: Only business email addresses obtained through sanctioned APIs (Apollo, Hunter) or publicly declared company inboxes are utilized.
- **Strict Rate Limiting**: All sources adhere to polite robots.txt intervals with automatic backoff.
- **Local SQLite Storage**: All pipeline state is stored locally in `data/leadintel.db` using Node's native SQLite with zero external database dependencies.
