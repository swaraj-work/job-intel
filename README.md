# JobIntel · Automated Founder Outreach & Job Discovery Engine

The default **Latest jobs** inbox tracks AI, backend, full-stack, SDE I and software internships for early-career candidates in India. Choose the past hour, 24 hours or seven days. The inbox uses publication time, marks relative timestamps as approximate and groups undated items found this week separately. Use search, experience and startup filters to narrow results. The **For You** view uses your profile to rank matches, and each account keeps its own saved, applied and dismissed posts. Open a post to apply or reply, or open **Company & outreach** when a pipeline record is available.

**Funding signals** surfaces fundraising articles for outreach before a role is advertised. The Daily 20 and Pipeline views track companies, contacts, drafts and follow-ups.

### Discovery sources

- Scheduled public sources include YC India job listings, employer comments in Hacker News’ monthly hiring thread, r/bangalorejob, developer subreddits, Indian funding news, and the careers boards of Sarvam, Meraki Labs, Certa and Composio. Add an Ashby board by its slug or add an RSS/Atom feed under **Sources**.
- LinkedIn Jobs, Indeed India and Naukri have public search pages configured through Jina Reader. Coverage depends on the publisher returning public listing links. The source panel shows fetch errors, including verification pages. Custom Reader sources accept a public careers page URL. Reader can parse job links and nearby timestamps from Markdown. [Jina Reader](https://jina.ai/reader/)
- To monitor X, set `X_BEARER_TOKEN`. For additional board coverage, set `SERPAPI_API_KEY`. Indexed results link to the provider’s application page. Both integrations use the service’s search quota. The server enables their built-in sources when credentials are set. [X recent search](https://docs.x.com/x-api/posts/search/quickstart/recent-search) · [Google Jobs provider](https://serpapi.com/google-jobs-api)
- New high-frequency sources generally poll every 10–20 minutes. The inbox refreshes every 30 seconds while visible. Host throttling and third-party indexing can delay discovery.

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
   - Configure your target roles (e.g. *Software Engineering Intern*, *Backend Engineer*), core tech stack (*React*, *Node.js*, *Python*, *PostgreSQL*), portfolio, GitHub, and one-liner pitch.
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
cd job-intel
npm install
```

### 3. Configure Google sign-in
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
In Google Cloud, create a **Web application** OAuth client with an external audience and publish the app to allow general Google-account signups. Register `http://localhost:4300/auth/google/callback` for local development and `https://YOUR-DOMAIN/auth/google/callback` for deployment. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the production `APP_ORIGIN` in the service environment. Railway’s public service domain is used when `APP_ORIGIN` is unset. The sign-in flow requests identity permissions. The **Open in Gmail** action opens a pre-filled compose window.

Key configuration options:
- `PORT`: Server port (default: `4300`)
- `GROQ_API_KEY` or `GEMINI_API_KEY`: Enables LLM extraction and bespoke email personalization (if omitted, high-speed heuristic rules run with zero cost).
- `APOLLO_API_KEY` or `HUNTER_API_KEY`: Enables automatic verified founder work email lookups.
- Provider calls against service-owned credentials are capped across all accounts. See the `*_SHARED_DAILY_CAP` settings in `.env.example`.

### 4. Run the Engine
```bash
npm start
```
Open [http://localhost:4300](http://localhost:4300) in your browser. Run `npm test` to check sign-in, workspace isolation, and discovery.

If Railway's install step reports the npm production config warning, remove `NPM_CONFIG_PRODUCTION` from the service variables and use `NPM_CONFIG_OMIT=dev` for production-only installs.

---

## Delete your account

Open **Profile → Delete account** and type `DELETE` to confirm. JobIntel deletes the workspace and signs you out on all devices. Signing in again creates a fresh workspace. JobIntel attempts to revoke any connected Gmail grant. If Google cannot complete the revocation, the sign-in page links to your Google Account connections.

## Connect Gmail and write outreach

Use the **Gmail** tab to connect the same Google account used for sign-in, read recent inbox messages, and open Gmail for messages that need HTML rendering or attachments. Gmail access is optional. The app keeps mail in Gmail and stores the encrypted refresh token in the account’s workspace.

In **Company & outreach**, choose a template based on the latest signal, a founder introduction, a hiring post, funding, or a follow-up. Templates use your candidate profile and the company’s recorded signals. Edit the recipient, subject, and message, then choose **Save to Gmail drafts**. Review and send the message in Gmail, and use **Mark as sent** to update JobIntel.

To enable the integration:

1. Create a dedicated Google OAuth **Web application** client, preferably in a separate Cloud project from sign-in. Enable the Gmail API and register the exact callback for each environment, such as `http://localhost:4300/api/gmail/callback` or `https://YOUR-DOMAIN/api/gmail/callback`.
2. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_TOKEN_KEY`. Generate the key with `openssl rand -base64 32` and keep it stable across restarts. Changing it requires users to reconnect.
3. Configure Google consent for `gmail.readonly` and `gmail.compose`. With an external consent screen in testing, add the accounts that will test it. These are restricted scopes, so complete Google’s applicable verification and security assessment for a public rollout. [Gmail scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes)

## Scoring Model (Opportunity Fit)

Every company is evaluated against a 100-point opportunity scoring model:

| Factor | Weight | What it Evaluates |
| :--- | :--- | :--- |
| **Seed / Early Funding** | 30 pts | Recent Pre-Seed, Seed, Angel, or Series A funding (fresh capital deployed for hiring). |
| **Hiring Signal** | 25 pts | Explicit hiring announcement, junior engineering opening, or active developer job posts. |
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
- **Source limits**: Fetches are paced by host, back off after rate limits, and block private network destinations.
- **SQLite storage**: The catalog database stores Google identities, sessions, and built-in discovery. Private state lives in one SQLite file per account in the workspace directory. On a single Railway replica, mount a persistent volume for both the catalog and workspace files. Their default paths are `data/jobintel.db` and `data/jobintel.db.workspaces` locally, or the corresponding paths under the Railway volume. The app expects a fresh catalog and does not import the legacy single-user database. Public data is fetched centrally. Private source polling and enrichment run for recently active accounts and resume when the account returns.
