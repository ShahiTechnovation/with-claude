/**
 * EDITORIAL DECISIONS for the September 2026 Bhopal event archive.
 *
 * One entry per source row, keyed by EXCEL ROW NUMBER (header = row 1) of
 * `Form responses 1` in each workbook. Row numbers are provenance — the
 * adapter matches a row back to these decisions by its coordinate AND checks
 * the row still says what the decision was made about (`expect`), so a
 * reordered or revised workbook fails loudly instead of attaching a summary to
 * the wrong project.
 *
 * What lives here: titles where the form had no title field (or the title
 * field was wrong), a short card summary written FROM the submission, a
 * category from the site's existing list, holds with a concrete reason, and
 * notes on link repairs. What never lives here: emails, member names, the
 * withheld admin URL, or anything else private. The full narrative is read
 * from the workbook at import time and kept verbatim.
 *
 * Summaries describe what the team says the project does. They do not add
 * achievements, rankings, production readiness or model usage the submission
 * does not state.
 */

export type Category = 'product' | 'agent' | 'developer-tool' | 'research' | 'creative' | 'campus' | 'experiment' | 'startup';

export interface RowEditorial {
  /** A fragment that must appear in the row's repo/live/title cells — the identity check. */
  expect: string;
  disposition: 'publish' | 'hold' | 'quarantine' | 'merged';
  /** For `merged`: the row that is the canonical submission of this project. */
  mergeInto?: number;
  title?: string;
  /** Where the title comes from. Required whenever `title` is set. */
  titleEvidence?: string;
  summary?: string;
  category?: Category;
  /** The team label is (or is built from) a person's name: not published. */
  withholdTeamLabel?: boolean;
  /** Concrete, resolvable reasons. Required for `hold` and `quarantine`. */
  holds?: string[];
  /** Repairs and reclassifications, for the reconciliation report. */
  notes?: string[];
  /**
   * Explicit link decisions, overriding the classifier. `null` withholds that
   * kind. Values are public URLs the submission itself supplied.
   */
  links?: Partial<Record<'live' | 'repo' | 'video' | 'download' | 'artifact' | 'altVideo', string | null>>;
  /** Override the extracted "How Claude was used" text; `null` means none. */
  claudeUsage?: string | null;
}

export interface RepeatGroup {
  /** The canonical row; its key and slug identify the project. */
  primary: number;
  rows: number[];
  /** Row whose problem/solution text is used (default: the latest non-empty). */
  narrativeFrom?: number;
  /** Row whose self-reported status is used, and why. */
  statusFrom: number;
  statusReason: string;
  /** Primary demo row when several rows supply different demos. */
  demoFrom?: number;
  reason: string;
}

// ═══ IMPACT LAB 2 · held 15 Sep 2026 (rescheduled from 13 Sep) ═══════════

export const IMPACT_LAB_2: Record<number, RowEditorial> = {
  2: {
    expect: 'abhilash-chaudhary/SortX',
    disposition: 'publish',
    summary:
      'Turns messy, duplicated municipal complaints into structured tickets with the department, urgency and location identified, and a person approving each one.',
    category: 'product',
  },
  3: {
    expect: 'Shivamjais2106/TIMS',
    disposition: 'hold',
    title: 'TIMS',
    titleEvidence: 'Proposed from the repository (TIMS) and deployment (tims-monitoring); the submitted name was "Civic service".',
    summary:
      'Detects and classifies thermal hotspots from NASA FIRMS satellite data, separating likely industrial fires from wildfires, crop burning and other heat sources, with alerts on a dashboard.',
    category: 'research',
    holds: [
      'title: the submitted project name (N3) does not match the thermal-monitoring project its repository and deployment describe — confirm the name',
    ],
  },
  4: {
    expect: 'scam-security-assistent',
    disposition: 'publish',
    summary:
      'Helps people tell whether a message, app or call is a cyber-fraud attempt, explains the risk and gives simple safety and recovery steps.',
    category: 'product',
    notes: [
      'R4 was owner/repo shorthand; expanded to a GitHub URL (accessibility not verified)',
      'the solution text (P4) calls the assistant "Nazar"; the submitted name (N4) is used',
    ],
  },
  5: {
    expect: 'Laaaaksh/disha',
    disposition: 'publish',
    summary:
      'A phone-first guide that turns a self-taught learner’s skills, goal, device and weekly hours into a short, ordered learning path of free resources, each with a small project.',
    category: 'product',
  },
  6: {
    expect: 'Republic-one/Claude-Hackathon',
    disposition: 'publish',
    summary:
      'A website for recording and tracking residents’ reports of problems with Bhopal’s public infrastructure and its management.',
    category: 'product',
  },
  7: {
    expect: 'utksahu30/Claude-Impact-Lab-15-Sept',
    disposition: 'publish',
    summary:
      'Triages, deduplicates and digests municipal complaints written in Hindi or English, keeping life-safety hazards at critical priority and falling back to offline rules when the AI is unreachable.',
    category: 'product',
  },
  8: {
    expect: 'harsh-1-code/Zenox2.0',
    disposition: 'publish',
    summary:
      'Assesses a suspicious message, screenshot, app or call for fraud, lists what to do in the next ten minutes, and gives recovery steps if money has already been sent.',
    category: 'product',
  },
  9: {
    expect: 'shikhaj-stack/jobg',
    disposition: 'publish',
    summary: 'A career-readiness platform that helps students and aspiring developers prepare for roles in technology.',
    category: 'product',
  },
  10: {
    expect: 'rudrakanya/Claude-ImpactLab',
    disposition: 'publish',
    summary:
      'A short learner intake — skills, interests, English comfort and goals — mapped offline to an ordered path of free resources, with a small project at each step.',
    category: 'product',
  },
  11: {
    expect: 'kunalmamgai/Claude-Impact-Labs',
    disposition: 'publish',
    summary:
      'Job seekers speak for about a minute in Hindi, English or Hinglish; it builds a career profile, explains which opportunities they are eligible for and creates a bilingual resume.',
    category: 'product',
  },
  12: {
    expect: 'adilrehman786/vidyapath',
    disposition: 'publish',
    summary:
      'Creates curriculum-aligned, classroom-ready AI lessons for Classes 6–10 from the class, topic, time, language and equipment available, even without a computer lab.',
    category: 'product',
    notes: [
      'roster: M12 declares 4 members but slot I12 holds two names — team size and individual credits are not published; roster correction requested',
    ],
  },
  13: {
    expect: 'Anxhhhh/scam-detection',
    disposition: 'publish',
    summary:
      'Analyses suspicious messages, screenshots, calls and app requests for scam indicators, explains the risks and gives immediate safety and recovery guidance.',
    category: 'product',
  },
  14: {
    expect: 'hakamcodes/crowdsenseaibhopal',
    disposition: 'publish',
    summary:
      'Turns a citizen’s photo of a pothole, garbage or a broken streetlight into a ward-located, classified complaint routed to the responsible Bhopal Municipal Corporation department.',
    category: 'product',
    notes: [
      'related to the existing Impact Lab 1 project /projects/crowd-sense-ai/ (same GitHub owner, different repository and deployment) — kept separate',
      'W14 (hackathon-work acknowledgement) is blank in the source',
    ],
  },
  15: {
    expect: 'omsinghethdev/SakshamPath',
    disposition: 'publish',
    summary: 'A voice-first career guidance platform that takes a job seeker from a voice note to a job-ready profile.',
    category: 'product',
    notes: ['S15 repeats the repository from R15; one repository action is shown'],
  },
  16: {
    expect: 'nagar-setu',
    disposition: 'hold',
    title: 'Nagar Setu',
    titleEvidence: 'Proposed from the repository and deployment (nagar-setu); the submitted name (N16) is the single letter "R".',
    summary:
      'Turns a messy municipal complaint — voice, text or photo — into a structured, routed and duplicate-checked ticket, with a zone-office operator approving every step.',
    category: 'product',
    holds: ['title: N16 is "R"; confirm "Nagar Setu" (or the correct name)'],
    notes: [
      'R16 was owner/repo shorthand; expanded to a GitHub URL (accessibility not verified)',
      'U16 ("Ask me") is not a link and is ignored',
    ],
  },
  17: {
    expect: 'workob-in-claude-hackathon-15-sept',
    disposition: 'publish',
    summary:
      'Turns a job seeker’s short voice note into a structured profile, explains which jobs and apprenticeships they qualify for and why, and drafts a bilingual resume.',
    category: 'product',
    notes: [
      'S17 was a scheme-less domain; https:// added',
      'the narrative (O17/P17) calls the product "KaamSetu"; the submitted name (N17), repository and deployment say "workob in"',
    ],
  },
  18: {
    expect: 'ayushjainprofile-tech/scam-x',
    disposition: 'publish',
    summary:
      'A browser extension that checks suspicious text, screenshots and links for scam signals, explains the evidence and suggests safe next steps.',
    category: 'product',
    notes: ['S18 is a Vercel dashboard link, not a public demo — not used; the repository and demo video are'],
  },
  19: {
    expect: 'prathamjain01/CLAUDE-BHOPAL',
    disposition: 'publish',
    summary:
      'Identifies a learner’s skill gaps and gives them the next best step — a free resource and a small project — adapting it as they progress.',
    category: 'product',
  },
};

// ═══ CLAUDE CODE BUILD DAY — FABLE 5.1 · held 20 Sep 2026 ════════════════

export const FABLE_5_1: Record<number, RowEditorial> = {
  2: {
    expect: 'tarunsarathe07-stack/ek-rasta',
    disposition: 'publish',
    title: 'Ek Rasta',
    titleEvidence: 'G2: "Ek Rasta maps government paperwork as a directed graph…"',
    summary:
      'Maps government paperwork as a dependency graph and finds circular document requirements — such as a ration card that needs proof of residence that needs a ration card.',
    category: 'research',
    withholdTeamLabel: true,
  },
  3: {
    expect: 'GJHKGVJHVK',
    disposition: 'quarantine',
    holds: ['suspected test entry: every field is placeholder text and neither link is a URL'],
  },
  4: {
    expect: 'petbotinofficial-ai/petbot.ai',
    disposition: 'publish',
    title: 'Petbot',
    titleEvidence: 'G4: "Petbot is a personalized smart pet-tag platform…"',
    summary:
      'Personalised pet tags with a QR code that links a lost pet’s tag to its digital profile, plus a dashboard for running the business behind them.',
    category: 'product',
  },
  5: {
    expect: 'Yashraj00700/pramaan',
    disposition: 'hold',
    title: 'DocsGuard',
    titleEvidence: 'G5 names "DocsGuard"; the repository and deployment are named "pramaan".',
    summary:
      'Checks uploaded certificates, invoices and IDs for signs of forgery, combining deterministic forensic checks with Claude’s reading of the document, and returns a risk score with the evidence.',
    category: 'product',
    holds: ['title: the narrative says "DocsGuard" but the repository and deployment say "Pramaan" — confirm the project name'],
  },
  6: {
    expect: 'abbas-rz/safe-not-sorry',
    disposition: 'publish',
    title: 'Safe, Not Sorry',
    titleEvidence: 'G6: "Safe, Not Sorry is an autonomous AI security engineer…"',
    summary:
      'An AI security agent that runs locally, attacks your own application and shows exactly which requests worked and what data it could reach.',
    category: 'developer-tool',
  },
  7: {
    expect: 'Sumit-Ks1/knowledge-fact-layer',
    disposition: 'publish',
    title: 'Fact Knowledge Layer',
    titleEvidence: 'G7: "I’m building an AI-powered Fact Knowledge Layer…" (repository: knowledge-fact-layer)',
    summary:
      'Extracts financial figures from company PDFs, links each one to its source passage and flags figures that corroborate, conflict or depend on context.',
    category: 'product',
  },
  8: {
    expect: 'TM23-sanji/headline_threads',
    disposition: 'hold',
    title: 'Headline Threads',
    titleEvidence: 'Repository name; the same repository is the existing project /projects/headline-threads/.',
    summary:
      'Groups follow-up news about the same event into chains, tags stories as delayed or ongoing, and sorts them by topic such as water, electricity or roads.',
    category: 'product',
    holds: [
      'cross-event duplicate: E8 is the repository of the existing Impact Lab 1 project /projects/headline-threads/ — decide whether this is the same project (keep one record) or a distinct Fable build',
    ],
    notes: ['H8 contained the same Google Videos URL pasted twice; parsed as one link'],
  },
  9: {
    expect: 'HarshJa1n/compute-atlas',
    disposition: 'publish',
    title: 'Compute Atlas',
    titleEvidence: 'G9: "Compute Atlas is a map-first workspace…"',
    summary:
      'A map-first workspace for screening Indian sites for AI data centres, giving each power, water and connectivity requirement an evidence-backed verdict — never a single score.',
    category: 'research',
    notes: ['H9 is a slide deck, not a screen recording — shown as an artifact, not a demo video'],
  },
  10: {
    expect: 'Bahisht',
    disposition: 'publish',
    title: 'Ration Setu',
    titleEvidence: 'F10/G10: "Ration Setu addresses…", "Ration Setu is a digital ration queue…"',
    summary:
      'A digital queue and token system for Fair Price Shops, so ration beneficiaries can see their place in line and estimated wait instead of queueing for hours.',
    category: 'product',
    notes: [
      'D10 is not a link (it holds a personal name) — not imported',
      'E10 was owner/repo shorthand; expanded to a GitHub URL (accessibility not verified)',
      'J10 (showcase field) holds the deployment; reclassified as the live demo',
    ],
  },
  11: {
    expect: 'alokmandavgane/bharat-darshan',
    disposition: 'publish',
    title: 'Bharat Darshan',
    titleEvidence: 'G11: "Bharat Darshan is India as a hand-made clay diorama…"',
    summary:
      'India as a tilt-and-tap 3D clay diorama in the browser, with each state’s story in Hindi or English and layers for rivers, railways and GI products.',
    category: 'creative',
    notes: ['D11 was a scheme-less domain; https:// added'],
  },
  12: {
    expect: 'ayushrai-hub/SpiderWeb',
    disposition: 'publish',
    title: 'SpiderWeb',
    titleEvidence: 'G12/G75: "SpiderWeb turns a user’s LinkedIn data export…"',
    summary:
      'Turns a LinkedIn data export into a dashboard showing how a professional network is structured, how it has changed and where relevant connections are.',
    category: 'product',
    notes: ['D12 repeats the repository from E12; one repository action is shown'],
  },
  13: {
    expect: 'Akshatmaurya25/potholes-detection-system',
    disposition: 'publish',
    title: 'RoadWatch MP',
    titleEvidence: 'G13: "RoadWatch MP turns any drive into a pothole survey."',
    summary:
      'Turns dashcam or phone footage into a deduplicated, geotagged and severity-graded list of potholes, ready to file as grievances.',
    category: 'product',
    withholdTeamLabel: true,
    notes: [
      'D13 lists a temporary ngrok tunnel and a domain; the tunnel is not published (flagged for accessibility review), the domain is the live demo',
      'E13 lists a Hugging Face Space and a GitHub repository; the GitHub repository is primary, the Space is shown as an artifact',
    ],
  },
  14: {
    expect: 'anirudh12032008/nyaya',
    disposition: 'publish',
    title: 'nyaya',
    titleEvidence: 'F14/G14: "nyaya turns it into an actual case", "nyaya is an ai legal assistant…"',
    summary:
      'An AI legal assistant that turns someone’s account of a legal problem, typed or spoken, into an organised case with the documents needed, legal-aid options and next steps.',
    category: 'product',
    notes: ['H14 lists two demo videos; the first is primary, the second is kept as a second demo'],
  },
  15: {
    expect: 'parazeeknova/fly-invaders',
    disposition: 'publish',
    title: 'Fly Invaders',
    titleEvidence: 'G15: "Fly Invaders is a live fruit-fly brain connectome…"',
    summary:
      'A simulated fruit-fly brain connectome — about 167,000 neurons — wired up as the controller for a game of Space Invaders.',
    category: 'research',
  },
  16: {
    expect: 'Rupali59/headroom-mp',
    disposition: 'publish',
    title: 'Headroom MP',
    titleEvidence: 'G16: "Headroom MP turns that published record into one view…"',
    summary:
      'Assembles Madhya Pradesh’s published substation-loading records into one view of night-time grid headroom for siting data centres, with a cited verdict per factor.',
    category: 'research',
    notes: [
      'D16 has the deployment URL inside prose; extracted',
      'H16 (demo video field) repeats the app URL — it is not a video and is not shown as one',
    ],
  },
  17: {
    expect: 'amanmaqsood/watchread',
    disposition: 'publish',
    title: 'WatchRead',
    titleEvidence: 'F17/G17: "WatchRead is built for students…", "WatchRead turns a lecture transcript…"',
    summary:
      'Turns a lecture transcript into a study companion with chapters, a glossary and practice questions, with every explanation linked back to the source passage.',
    category: 'product',
    notes: ['A17 is the literal text "V", not a timestamp — submission time unknown; the event association is unaffected', 'C17 is "N/A": no team label'],
  },
  18: {
    expect: 'Rachit-Tiwari-7/SYNAPSE-NEURAL',
    disposition: 'publish',
    title: 'Synapse-OS',
    titleEvidence: 'G18: "Synapse-OS is an autonomous, multi-agent clinical operating system…"',
    summary:
      'A multi-agent clinical assistant reached through WhatsApp and voice that assesses symptoms, checks for drug interactions and gives ICMR-aligned guidance.',
    category: 'agent',
  },
  19: {
    expect: 'prajithparan/AI-Boosted-5G-Advanced-Core-and-Charging-R19',
    disposition: 'hold',
    title: 'AI-Boosted 5G Advanced Core and Charging',
    titleEvidence: 'Proposed from the repository name; the submission states no project name.',
    summary: 'An AI-native core BSS/OSS for telecom operators.',
    category: 'developer-tool',
    holds: ['title and description: no project name is stated and F19/G19 are one line each — ask the team for a name and a short description'],
    notes: ['C19 is "N/A": no team label'],
  },
  20: {
    expect: 'prajapati-arjun/cc_simhastha2028',
    disposition: 'hold',
    title: 'Simhastha 2028 platform',
    titleEvidence: 'Proposed from the repository (cc_simhastha2028); the deployment is vandanai.in and the narrative states no name.',
    summary:
      'One platform for Simhastha 2028 in Ujjain: live maps, crowd and traffic updates, services and a multilingual assistant for pilgrims, with a monitoring dashboard for authorities.',
    category: 'product',
    withholdTeamLabel: true,
    holds: ['title: no project name is stated; the repository and deployment use different names — confirm the name'],
    notes: ['D20 was a scheme-less domain; https:// added'],
  },
  21: {
    expect: 'PriyanshuRaj2077/BuilderLabs',
    disposition: 'publish',
    title: 'SuchakAI',
    titleEvidence: 'G21: "SuchakAI is an AI-powered personalized government-scheme discovery platform."',
    summary:
      'Matches citizens to the government schemes, scholarships and subsidies that fit their profile, explaining eligibility, documents, steps and deadlines.',
    category: 'product',
  },
  22: {
    expect: 'Vinayak109/Anuvaa-app',
    disposition: 'publish',
    title: 'ANUVAA',
    titleEvidence: 'G22: "ANUVAA is an offline AI-powered classroom copilot…"',
    summary:
      'An offline classroom assistant that turns a teacher’s Hindi speech into Santali (Ol Chiki) speech and bilingual learning material for multilingual primary classrooms.',
    category: 'product',
    notes: ['D22 carried a _vercel_share access parameter; it is removed and the clean URL is published only if it verifies as public'],
  },
  23: {
    expect: 'ViratSrivastava/DIC',
    disposition: 'publish',
    title: 'DIC - Developers Integration Console',
    titleEvidence: 'G23: "DIC - Developers Integration Console"',
    summary: 'A console for end-to-end SQL-to-GraphQL migration across Supabase, AWS RDS and PostgreSQL.',
    category: 'developer-tool',
    notes: ['D23 and E23 were scheme-less; https:// added'],
  },
  24: {
    expect: 'Aditya12119/simplexplain-ai',
    disposition: 'publish',
    title: 'SimpleExplain AI',
    titleEvidence: 'G24: "SimpleExplain AI is a lightweight web application powered by Claude…"',
    summary:
      'Paste in difficult text and get it back as a simple explanation, an explanation for a ten-year-old, or a short summary.',
    category: 'product',
  },
  25: {
    expect: 'abhaysahu403/SafeSphere',
    disposition: 'publish',
    title: 'SafeSphere',
    titleEvidence: 'G25: "SafeSphere is an AI- and AR/VR-powered disaster preparedness platform…"',
    summary:
      'A disaster-preparedness platform where students and school staff rehearse fire, flood and earthquake responses through AR/VR drills, with multilingual voice guidance and an SOS feature.',
    category: 'product',
  },
  26: {
    expect: 'Yu-369/Strata',
    disposition: 'publish',
    title: 'Strata',
    titleEvidence: 'G26: "Strata reconstructs the Great Bath of Mohenjo-daro…"',
    summary:
      'Reconstructs the Great Bath of Mohenjo-daro in 3D from excavation records, tagging every element as measured, inferred or unconfirmed, with a timeline of the site.',
    category: 'research',
  },
  27: {
    expect: 'aloks1701/Hisaab-Android',
    disposition: 'publish',
    title: 'Hisaab',
    titleEvidence: 'G27: "Hisaab (हिसाब) is an Android app…"',
    summary:
      'An Android app that reads UPI payment notifications and keeps a Hindi-first expense ledger on the phone, with no manual entry and no data leaving the device.',
    category: 'product',
    withholdTeamLabel: true,
    notes: ['D27 is a GitHub release page; shown as a download, not a live website'],
  },
  28: {
    expect: 'HarrisWarner04/ClaudeBuildDay',
    disposition: 'publish',
    title: 'miniVoxSetu',
    titleEvidence: 'G28: "miniVoxSetu is a real-time voice AI platform…"',
    summary:
      'A real-time voice AI for banking customer service that handles interruptions and detects emotion; the team reports responses in under 300 ms.',
    category: 'agent',
  },
  29: {
    expect: 'ikunalkumararya/IncidentOS',
    disposition: 'publish',
    title: 'IncidentOS',
    titleEvidence: 'G29: "IncidentOS is an AI-powered incident investigation and remediation platform…"',
    summary:
      'Connects customer-reported shop issues to an engineering dashboard where Claude investigates logs, metrics and code, proposes a patch and verifies it with tests.',
    category: 'developer-tool',
  },
  30: {
    expect: 'opd-flow-omega',
    disposition: 'publish',
    title: 'Chikitsa Setu',
    titleEvidence: 'G30: "Chikitsa Setu routes government hospital patients…"',
    summary:
      'Routes government-hospital outpatients by typed or spoken symptoms to emergency, suspected-cancer or routine pathways, and records the cause of every delay.',
    category: 'product',
    notes: ['E30 is a social handle, not a repository — no repository is shown; ask the team for one'],
  },
  31: {
    expect: 'mraashuJI/bhopalflow-ai',
    disposition: 'hold',
    title: 'BhopalFlow AI',
    titleEvidence: 'G31: "BhopalFlow AI is a smart traffic and mobility decision-support dashboard."',
    summary:
      'A traffic decision-support dashboard for Bhopal that maps congestion, predicts the next hour’s build-up and simulates emergency-vehicle priority, on simulated data.',
    category: 'product',
    holds: [
      'possible duplicate of row 80 (BHOPAL//FLOW): same team label "Team Eklavya" and both are Bhopal traffic decision-support tools, but they come from different submitters with a different repository and deployment — confirm one project or two before publishing either (not merged on team name)',
    ],
    notes: ['same team label as row 80 (BHOPAL//FLOW), but a different repository and deployment — kept separate pending an organiser decision'],
  },
  32: {
    expect: 'tanushsahu-fisrt/claude-hackathon',
    disposition: 'hold',
    title: 'Brain Sprint',
    titleEvidence: 'F32 says "Brain Sprint"; G32 says "mental+Math".',
    summary:
      'A browser mental-maths game with timed rounds, levels, streaks and badges, and a performance analysis after every round.',
    category: 'creative',
    holds: ['title: the submission uses two names ("Brain Sprint" and "mental+Math") — confirm which'],
  },
  33: {
    expect: 'Aryan-coder-student/Build-Claude-Code',
    disposition: 'hold',
    title: 'AI product demo agent',
    titleEvidence: 'Descriptive placeholder; the submission states no name and the repository name is generic.',
    summary:
      'An AI product-demo agent embedded in a SaaS website that answers questions and can navigate the interface to demonstrate features live.',
    category: 'agent',
    withholdTeamLabel: true,
    holds: ['title: no project name is stated — ask the team for one'],
    notes: ['D33 is a temporary trycloudflare tunnel — not published; flagged for accessibility review'],
  },
  34: {
    expect: 'glitchmatrix09/reasoning-arena',
    disposition: 'publish',
    title: 'Reasoning Arena',
    titleEvidence: 'Repository and deployment are both named reasoning-arena.',
    summary:
      'An AI that argues both sides of forensic DNA-mixture evidence, with a checker that flags arguments that overreach; the demo uses synthetic data and pre-written arguments.',
    category: 'research',
    notes: ['J34 is the showcase template text (it names team members); not imported'],
  },
  35: {
    expect: 'Whynav/fourbysix-',
    disposition: 'publish',
    title: 'fourbysix',
    titleEvidence: 'Repository and deployment are both named fourbysix; G35 describes "this 4by6 card system".',
    summary: 'A writing tool built around the 4×6 index-card method for keeping track of good ideas.',
    category: 'product',
    notes: [
      'same team label as row 9 (Compute Atlas), different project and artifacts — kept separate',
      'H35 holds a Canva link and a Drive folder inside prose; the Drive folder is the demo, the Canva link an artifact',
    ],
  },
  36: {
    expect: 'KartikeyNamdev/YieldCompass_Backend',
    disposition: 'publish',
    title: 'YieldCompass',
    titleEvidence: 'G36: "YieldCompass is a search engine for Solana DeFi yield."',
    summary:
      'A search engine for Solana DeFi yields that separates real yield from token emissions and gives each protocol a rule-based 0–100 risk score.',
    category: 'product',
  },
  37: {
    expect: 'amanmaqsood/coursestudio',
    disposition: 'publish',
    title: 'CourseStudio',
    titleEvidence: 'G37: "CourseStudio takes raw knowledge and produces a complete interactive course."',
    summary:
      'Turns notes, transcripts, documents or a URL into a complete interactive course with lessons, diagrams, self-grading quizzes and a final project.',
    category: 'product',
    notes: ['C37 is "N/A": no team label'],
  },
  38: {
    expect: 'Rajdeeppatel1/claude-build-day-',
    disposition: 'hold',
    title: 'AnnaSetu',
    titleEvidence: 'Proposed from the deployment name (annasetu); G38 contains the literal placeholder "[Project Name]".',
    summary:
      'Connects people with surplus food, clothes and books to nearby NGOs and recipients, with Claude rating food safety and item condition before pickup.',
    category: 'product',
    holds: ['title: G38 says "[Project Name]" — confirm "AnnaSetu" or the correct name'],
  },
  39: {
    expect: 'sachmeetsb/Claude-Build---Luma-Event-Keys-Dispenser',
    disposition: 'publish',
    title: 'Luma Event Keys Dispenser',
    titleEvidence: 'Repository name (Claude-Build---Luma-Event-Keys-Dispenser).',
    summary:
      'A portal that hands each registered event participant an anonymised, single-use credit link, synced from the event’s guest list.',
    category: 'developer-tool',
    links: { live: null },
    notes: [
      'D39 is an admin endpoint carrying an access key: WITHHELD — never fetched, printed or published. Request a safe public demo URL; the owner should rotate or revoke the key if it is still active',
    ],
  },
  40: {
    expect: 'Adarsh9977/pokix',
    disposition: 'publish',
    title: 'Pokix',
    titleEvidence: 'Repository (pokix) and deployment (pokix-ten) agree.',
    summary: 'A game platform for AI agents.',
    category: 'experiment',
  },
  41: {
    expect: 'riyadadlani02/aidebugger',
    disposition: 'publish',
    title: 'aidebugger',
    titleEvidence: 'G41: "aidebugger arms non-stopping traps…"',
    summary:
      'Sets non-stopping traps on functions in a live Python AI agent, capturing arguments, locals and return values without ever pausing the process.',
    category: 'developer-tool',
  },
  42: {
    expect: 'ankandebbarmaa/thedungeon',
    disposition: 'publish',
    title: 'Founder Arena',
    titleEvidence: 'F42/G42: "Founder Arena is an AI-powered decision trial platform…"',
    summary:
      'Puts a startup or business decision on trial before several AI advisors — growth, risk, feasibility, assumptions — and returns a final verdict.',
    category: 'agent',
    notes: ['D42 is not a link (it holds a personal name) — not imported'],
  },
  43: {
    expect: 'deepakwadge81.github.io/kaksha',
    disposition: 'publish',
    title: 'KAKSHA',
    titleEvidence: 'G43: "KAKSHA is a flight simulator for teachers."',
    summary:
      'A practice simulator for trainee teachers: Claude plays five Grade 3 pupils with hidden learning levels and misconceptions, then a coach reviews what the teacher missed.',
    category: 'product',
    withholdTeamLabel: true,
    notes: [
      'D43 is not a link (it holds a personal name) — not imported',
      'E43 is a GitHub Pages deployment, not a repository — shown as the live demo; no repository was supplied',
    ],
  },
  44: {
    expect: 'ajstudd/jarvis',
    disposition: 'publish',
    title: 'JARVIS',
    titleEvidence: 'F44/G44: "I have built JARVIS…", "JARVIS, a holographic 3D design platform…"',
    summary:
      'A holographic 3D design tool: generate a 3D model of anything with AI, then explore and change it part by part with gestures and voice.',
    category: 'creative',
    notes: ['D44 is not a link (it holds a personal name) — not imported'],
  },
  45: {
    expect: 'localhost:8765',
    disposition: 'hold',
    title: 'AI credit navigation platform',
    titleEvidence: 'Descriptive placeholder; the submission states no name.',
    summary:
      'Builds a “financial twin” from a borrower’s consented data and, instead of a flat rejection, searches for workable alternatives such as a smaller loan or a longer tenure.',
    category: 'product',
    holds: [
      'no usable public artifact: E45 is a localhost address (never visited), D45 is a personal name and no demo was supplied — ask for a public repository, deployment or video',
      'title: no project name is stated',
    ],
  },
  46: {
    expect: 'iamadityakumar/predraider',
    disposition: 'publish',
    title: 'predraider',
    titleEvidence: 'Repository and deployment are both named predraider.',
    summary:
      'A Solana prediction-market bot that scans near-expiry markets and paper-trades only when an edge survives fees, liquidity and exposure checks.',
    category: 'experiment',
  },
  47: {
    expect: 'Ayushdev365/TraceX-VASP',
    disposition: 'publish',
    title: 'TraceX-VASP',
    titleEvidence: 'F47/G47: "TraceX-VASP is an explainable blockchain investigation platform…"',
    summary:
      'Traces cryptocurrency across wallets, mixers and bridges and scores which virtual-asset service provider a suspicious wallet most likely connects to, showing the evidence.',
    category: 'product',
  },
  48: {
    expect: 'WyrdWerk/what-s-the-cost',
    disposition: 'publish',
    title: 'What’s the cost?',
    titleEvidence: 'G48: "“What’s the cost?” is a mobile-first AI-agent cost estimator…"',
    summary:
      'A mobile-first estimator that shows Indian small businesses what an AI agent would really cost — setup, model, oversight and break-even — in Hindi or English.',
    category: 'product',
  },
  49: {
    expect: 'titanjagpreet/code-lantern',
    disposition: 'publish',
    title: 'CodeLantern',
    titleEvidence: 'G49: "CodeLantern turns any repository into a guided, verifiable story."',
    summary:
      'Turns a code repository into a guided tour with an architecture graph and user-journey traces, every claim checked against real line numbers.',
    category: 'developer-tool',
  },
  50: {
    expect: 'NAMANIND/claude-day-project',
    disposition: 'publish',
    title: 'LaunchJury',
    titleEvidence: 'G50: "LaunchJury is a CLI agent built on the Claude Agent SDK…"',
    summary:
      'A command-line agent that reads a repository, drafts a complete product launch and tests the drafts against a jury of seven audience personas before you post.',
    category: 'agent',
  },
  51: {
    expect: 'shriyanshiatgithub/didi',
    disposition: 'publish',
    title: 'didi',
    titleEvidence: 'Repository name (didi).',
    summary:
      'An Android pantry and diet app that suggests recipes from what you have, taking into account the local weather, dietary needs and fitness goals.',
    category: 'product',
    notes: ['D51 is a sentence ("It\'s an android app…"), not a link'],
  },
  52: {
    expect: 'RinciAtrey/Suvidha',
    disposition: 'publish',
    title: 'Suvidha',
    titleEvidence: 'Repository (Suvidha) and deployment (suvidhaportal) agree.',
    summary:
      'Pick a life event — marriage, moving city, a new baby, lost documents — and get an ordered checklist of documents to update with links to the official portals, plus a scheme eligibility check.',
    category: 'product',
    notes: ['J52 (showcase field) repeats the deployment; it is not a social post'],
  },
  53: {
    expect: 'github.com/aadarsh214',
    disposition: 'hold',
    title: 'mailsend.dev',
    titleEvidence: 'Proposed from G53/J53 ("Checkout : mailsend.dev"); not confirmed by an artifact.',
    summary: 'A transactional and marketing email platform built on domains, MCP and an API.',
    category: 'developer-tool',
    holds: [
      'no usable artifact: E53 is a GitHub profile, not a repository, and D53 is a personal name — the narrative points to mailsend.dev; ask the team to confirm it and supply the repository',
    ],
  },
  54: {
    expect: 'existential-crisis-debugger',
    disposition: 'publish',
    title: 'Existential Crisis Debugger',
    titleEvidence: 'F54/G54: "Existential Crisis Debugger is a terminal tool…"',
    summary:
      'A terminal tool that fixes Python bugs with Claude, checks each fix by re-running the code, and explains the lesson through a short philosophical monologue.',
    category: 'developer-tool',
    notes: ['D54 and E54 are the README; shown as one repository action'],
  },
  55: {
    expect: 'utksahu30/Alarum',
    disposition: 'publish',
    title: 'Contextual Alarms',
    titleEvidence: 'G55/G79: "Contextual Alarms is an Android app…" (team and repository: Alarum)',
    summary:
      'An Android app that reads your calendar and schedules every alarm and reminder automatically, adjusting them as your day changes.',
    category: 'product',
    notes: ['D55/D79 repeat the repository; one repository action is shown', 'J55 ("hi") is not showcase evidence'],
  },
  56: {
    expect: '7RLodhi/dating-chat-assistant',
    disposition: 'publish',
    title: 'Dating Chat Assistant',
    titleEvidence: 'Repository and deployment are both named dating-chat-assistant.',
    summary: 'Suggests personalised icebreakers and reply ideas for dating-app conversations, based on how the user writes.',
    category: 'experiment',
  },
  57: {
    expect: 'Shailesh-Pandey17',
    disposition: 'hold',
    title: 'AI form-filling service',
    titleEvidence: 'Descriptive placeholder; the repository name is not a clear project name.',
    summary: 'Automates form filling and dependency setup with an AI service.',
    category: 'developer-tool',
    holds: ['title and description: no clear project name and one-line problem/solution text — ask the team for a name and description'],
    notes: ['D57, H57 and J57 are the same Google Drive file; shown once, as the demo'],
  },
  58: {
    expect: 'Piyushrathoree/dark-soul',
    disposition: 'publish',
    title: 'Dark Soul',
    titleEvidence: 'Repository (dark-soul) and deployment (dark-soul-two) agree.',
    summary: 'A WebGL boss fight in the browser, modelled on the main boss of the Dark Souls games.',
    category: 'creative',
  },
  59: {
    expect: 'amanmaqsood/bookstudio',
    disposition: 'hold',
    title: 'VidBook Global',
    titleEvidence: 'G59 names "VidBook Global"; the repository and deployment are named bookstudio.',
    summary:
      'A self-publishing studio that checks a book idea against real catalogue data from Open Library, Apple Books and Google Books before producing the cover, listing and manuscript.',
    category: 'product',
    holds: ['title: the narrative says "VidBook Global" but the repository and deployment say "bookstudio" — confirm the project name'],
    notes: ['C59 is "N/A": no team label'],
  },
  60: {
    expect: 'bobbylobby-bot/CloneX',
    disposition: 'publish',
    title: 'CloneX',
    titleEvidence: 'F60/G60: "CloneX is designed for…", "CloneX is an AI tool…"',
    summary:
      'Simulates a conversation with an ex-partner from memories and chat examples the user supplies, clearly presented as an AI simulation rather than the real person.',
    category: 'experiment',
  },
  61: {
    expect: 'yashsingh77-coder/marketing-copilot',
    disposition: 'publish',
    title: 'Marketing Co-Pilot',
    titleEvidence: 'G61: "Marketing Co-Pilot — a web app…"',
    summary:
      'Takes a small-business owner with no marketing experience from a content strategy to captions, a posting calendar and performance tracking.',
    category: 'product',
    notes: ['H61 ("optional") is not a link'],
  },
  62: {
    expect: 'RavendraPatel09/Mp-Tourism',
    disposition: 'publish',
    title: 'MP Tourism',
    titleEvidence: 'Repository name (Mp-Tourism).',
    summary:
      'A travel-discovery app for exploring the tourist places of a city or state in one place: attractions, nearby places, activities, photos and directions.',
    category: 'product',
    notes: ['J62 is the showcase template text (it names team members); not imported'],
  },
  63: {
    expect: 'auenkr/claude-hackthon',
    disposition: 'publish',
    title: 'The Machine Archive',
    titleEvidence: 'G63: "The Machine Archive is an interactive virtual museum…"',
    summary:
      'A virtual museum of lost historical machines rebuilt as working 3D simulations, with every dimension traced to a text, an artefact or a labelled inference.',
    category: 'creative',
  },
  64: {
    expect: 'mishra-18/minivt',
    disposition: 'publish',
    title: 'minivt',
    titleEvidence: 'Repository name (minivt).',
    summary: 'A 2D renderer written from scratch, built to test Fable 5.1 on graphics programming, shaders and rendering maths.',
    category: 'experiment',
    withholdTeamLabel: true,
    notes: ['D64 is not a link (it holds a personal name) — not imported'],
  },
  65: {
    expect: 'Nihal-spec1/ASAI',
    disposition: 'publish',
    title: 'ASAI',
    titleEvidence: 'G65: "ASAI is an autonomous AI copilot for orbital safety."',
    summary:
      'An AI copilot for orbital safety that works through collision warnings, tasks sensors when uncertainty is high and proposes a manoeuvre behind a human sign-off.',
    category: 'research',
  },
  66: {
    expect: 'sawan-ade/The-Mirror',
    disposition: 'publish',
    title: 'THE MIRROR',
    titleEvidence: 'G66: "THE MIRROR is an AI-powered interactive visualization…"',
    summary:
      'Turns unstructured notes and journals into an explorable map of your ideas, showing what keeps recurring, what is emerging, what was forgotten and what connects.',
    category: 'product',
    withholdTeamLabel: true,
  },
  67: {
    expect: 'r3ban-hub/AFTERSHOCK-by-coffetiers',
    disposition: 'publish',
    title: 'AFTERSHOCK',
    titleEvidence: 'G67: "AFTERSHOCK uses AI to trace the ripple effects…"',
    summary:
      'Traces the ripple effects of a proposed project change across existing documents to surface hidden dependencies and evidence-backed consequences.',
    category: 'product',
    notes: ['D67 carried a _vercel_share access parameter; it is removed and the clean URL is published only if it verifies as public'],
  },
  68: {
    expect: 'hakamcodes/RouteX',
    disposition: 'publish',
    title: 'Skill-to-Opportunity Graph',
    titleEvidence: 'G68 and the deployment (skill-opportunity-graph) agree; the repository is named RouteX.',
    summary:
      'Parses skills and opportunity requirements into a graph and matches people to jobs, gigs and projects by semantic similarity rather than keywords.',
    category: 'product',
  },
  69: { expect: 'abhaysahu403/SafeSphere', disposition: 'merged', mergeInto: 25 },
  70: {
    expect: 'idharanithota/dont-touch-twice',
    disposition: 'publish',
    title: 'Don’t Touch Twice',
    titleEvidence: 'Repository name (dont-touch-twice).',
    summary: 'A puzzle game for thinking logically.',
    category: 'creative',
    notes: ['D70 is not a link (it holds a personal name) — not imported', 'J70 repeats the repository; not a social post'],
  },
  71: {
    expect: 'aryansharma4258-svg/rakfile0002',
    disposition: 'publish',
    title: 'RAKFILE',
    titleEvidence: 'G71: "RAKFILE scans uploaded projects…"',
    summary:
      'Scans an uploaded project for leaked secrets, malicious-looking code, corrupted, duplicate and unnecessary files, cleans what it safely can and scans again.',
    category: 'developer-tool',
    notes: ['D71 is not a link (it holds a personal name) — not imported'],
  },
  72: {
    expect: 'Kazuha-san/Drone-Simulation',
    disposition: 'publish',
    title: 'Drone Simulation',
    titleEvidence: 'Repository (Drone-Simulation) and deployment (drone-simulation-blue) agree.',
    summary:
      'A physics-grounded simulation comparing drone delivery with ground riders for quick commerce in Bhopal, calibrated against published trial data.',
    category: 'research',
  },
  73: {
    expect: 'aariz51/Distribution',
    disposition: 'publish',
    title: 'Distribution',
    titleEvidence: 'G73: "Distribution is an automated content creation and publishing platform…"',
    summary:
      'Turns one product profile and its existing videos into branded clips, thumbnails, platform-specific copy and scheduled social posts.',
    category: 'product',
    withholdTeamLabel: true,
  },
  74: { expect: 'ankandebbarmaa/thedungeon', disposition: 'merged', mergeInto: 42 },
  75: { expect: 'ayushrai-hub/SpiderWeb', disposition: 'merged', mergeInto: 12 },
  76: {
    expect: 'kanishk6103/HexEye',
    disposition: 'hold',
    title: 'FlyBrain · Asteroid Dodge',
    titleEvidence: 'G76 names "FlyBrain · Asteroid Dodge"; the repository and deployment are named HexEye.',
    summary:
      'A fruit fly whose looming-escape circuit is rebuilt from the FlyWire connectome, seeing through simulated compound eyes and dodging asteroids in the browser.',
    category: 'research',
    holds: ['title: the narrative says "FlyBrain · Asteroid Dodge" but the repository and deployment say "HexEye" — confirm the project name'],
  },
  77: {
    expect: 'Zugzwang-world/bundle-v0.2',
    disposition: 'publish',
    title: 'Bundle',
    titleEvidence: 'G77: "Bundle is a single on/off switch on Claude’s chat list."',
    summary:
      'A switch for Claude’s chat list that gathers related conversations into named, collapsible groups without moving or deleting anything.',
    category: 'product',
    claudeUsage:
      'Claude is used only where judgement is needed: writing each chat’s title and summary, naming a group, and breaking ties.',
  },
  78: {
    expect: 'ashudotbuilds/buildDay',
    disposition: 'hold',
    title: 'Personalised audio lessons',
    titleEvidence: 'Descriptive placeholder; the submission states no name and the repository name is generic.',
    summary:
      'Type a topic and how much time you have, answer three questions, and get a researched audio lesson sized to exactly that window.',
    category: 'product',
    holds: ['title: no project name is stated — ask the team for one'],
  },
  79: { expect: 'utksahu30/Alarum', disposition: 'merged', mergeInto: 55 },
  80: {
    expect: 'Pankaj2006-pm/Bhopal-flow',
    disposition: 'hold',
    title: 'BHOPAL//FLOW',
    titleEvidence: 'G80: "BHOPAL//FLOW is an AI-powered traffic incident decision-support system…"',
    summary:
      'A traffic-incident decision tool: report an accident, waterlogging or a rally in plain language and get a simulated severity assessment, diversion routes and resource suggestions.',
    category: 'product',
    holds: [
      'possible duplicate of row 31 (BhopalFlow AI): same team label "Team Eklavya" and both are Bhopal traffic decision-support tools, but they come from different submitters with a different repository and deployment — confirm one project or two before publishing either (not merged on team name)',
    ],
    notes: [
      'same team label as row 31 (BhopalFlow AI), but a different repository and deployment — kept separate pending an organiser decision',
      'F80 is "Na"',
    ],
  },
  81: {
    expect: 'sinfiny/jev-feed',
    disposition: 'publish',
    title: 'Jev Feed',
    titleEvidence: 'Repository and deployment are both named jev-feed.',
    summary: 'A feed modifier that curates a child’s — or anyone’s — social feed to their liking, to cut low-value screen time.',
    category: 'product',
  },
  82: {
    expect: 'i-hamdan/rote-learning',
    disposition: 'publish',
    title: 'Rote Learning',
    titleEvidence: 'G82: "Rote Learning turns individual NCERT textbook sections into three-minute playable labs."',
    summary:
      'Turns NCERT physics sections for Classes 9 and 10 into three-minute playable labs that work offline on a cheap phone or a classroom projector.',
    category: 'product',
    notes: ['D82 is not a link (it holds a personal name) — not imported', 'H82 was a scheme-less YouTube URL; https:// added'],
  },
  83: {
    expect: 'anugrah-eng/bharatvrsh',
    disposition: 'publish',
    title: 'BharatVRsh',
    titleEvidence: 'G83: "Our BharatVRsh platform brings these assets into interactive virtual museums…"',
    summary:
      'A virtual-museum platform that brings photogrammetry and LiDAR scans of Indian heritage sites and artefacts into interactive, multilingual 3D experiences.',
    category: 'creative',
    notes: [
      'D83 repeats the repository; one repository action is shown',
      'X8 Studio also submitted an Impact Lab 2 project; a recurring team name does not make them the same project',
    ],
  },
};

/**
 * REPEAT SUBMISSIONS — one project, several rows. Field-level merge: each
 * field comes from the latest row that has it, unless stated here, and a
 * blank in a later row never erases an earlier value. Provenance per field is
 * recorded in the reconciliation report.
 */
export const FABLE_REPEATS: RepeatGroup[] = [
  {
    primary: 12,
    rows: [12, 75],
    narrativeFrom: 75,
    statusFrom: 75,
    statusReason: 'row 75 is the later revision (Partially functional); row 12 said Prototype / demonstration only',
    reason: 'same repository and submitter; the narrative was resubmitted with the functionality answer changed',
  },
  {
    primary: 25,
    rows: [25, 69],
    narrativeFrom: 25,
    statusFrom: 25,
    statusReason: 'both rows say Fully functional',
    demoFrom: 69,
    reason:
      'same repository and deployment; row 69 adds the demo video and leaves the team label blank (the blank does not erase "BuidX"), and its problem/solution answers are swapped, so row 25’s are used',
  },
  {
    primary: 42,
    rows: [42, 74],
    narrativeFrom: 74,
    statusFrom: 74,
    statusReason: 'both rows say Fully functional',
    demoFrom: 74,
    reason: 'same repository and submitter; each row supplies a different demo video — row 74’s is primary, row 42’s is kept as a second demo',
  },
  {
    primary: 55,
    rows: [55, 79],
    narrativeFrom: 79,
    statusFrom: 79,
    statusReason: 'both rows say Partially functional',
    demoFrom: 79,
    reason: 'same repository and submitter; row 79 adds the demo video (its trailing backslash removed) and revises the problem text',
  },
];
