/**
 * EDITORIAL DECISIONS for the October 2026 Bhopal Impact Lab (11 Oct).
 *
 * One entry per source row, keyed by EXCEL ROW NUMBER (header = row 1) of
 * `Form responses 1`. The adapter checks each row still says what the
 * decision was made about (`expect`), so a reordered or revised export fails
 * loudly instead of attaching a summary to the wrong project.
 *
 * What lives here: a one-line card summary in the team's own words, a
 * category, holds with a concrete reason, notes, and the decisions taken on
 * 2026-10-17: row 57 dropped and row 61 kept, U35's typo corrected, and (at
 * 14:57) titles published as written — only two problem statements were set,
 * so many teams named their project after the track; the adapter notes each
 * same-title row and its team label tells it apart. What never lives
 * here: emails, member names, or anything else private. The narrative (P–S)
 * is read from the export at import time and kept verbatim.
 *
 * Summaries say what the team says the project does. They add no
 * achievements, rankings, production readiness or model usage the
 * submission does not state.
 */
import type { Category } from '../event-archive-2026-09/editorial';

export interface LabEditorial {
  /** A fragment that must appear in the row's T/U/V/O/E cells — the identity check. */
  expect: string;
  /** `dropped`: not imported at all; the reason goes in `holds`. */
  disposition: 'publish' | 'hold' | 'dropped';
  /** The card line. Required unless dropped. */
  summary?: string;
  category?: Category;
  /** The team label is not a team name (a URL): not published. */
  withholdTeamLabel?: boolean;
  /** Concrete, resolvable reasons. Required for `hold` (unless the adapter adds one) and `dropped`. */
  holds?: string[];
  notes?: string[];
  /** Explicit link decisions, overriding the classifier. `null` withholds that kind. */
  links?: Partial<Record<'live' | 'repo' | 'video', string | null>>;
  /** S is not an answer: "How Claude was used" comes from the team's own sentences in Q/R. */
  usageFromNarrative?: boolean;
}

const oneLine = (row: number) =>
  `description: P${row} and Q${row} are one line each — ask the team for a short description`;

export const IMPACT_LAB_OCTOBER: Record<number, LabEditorial> = {
  2: {
    expect: '-redakai/bhumi-vikas-sahayak',
    disposition: 'publish',
    summary:
      'Answers Bhopal building-rule questions in English or Hindi with the rule number, PDF page and verbatim quote, and says "not found" when the rules are silent.',
    category: 'product',
  },
  3: {
    expect: 'dopesing3-bita/ghat-watch',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s Visarjan ghats for water-quality monitoring from historical MPPCB readings, each traced to its report page, with Hindi or English briefings.',
    category: 'product',
  },
  4: {
    expect: 'Nikhilncy/visarjan-sentinel',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s immersion ghats by priority from historical water-quality data, charts pollution against CPCB benchmarks and writes Hindi and English briefs.',
    category: 'product',
  },
  5: {
    expect: 'Yu-369/Jal-Prahari-The-Water-Sentinel',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven visarjan ghats by water-quality risk and allocates aeration units, testing kits and cleaning crews to the ghats that need them.',
    category: 'product',
  },
  6: {
    expect: 'Devpatelgurjar/Ghat-watch',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven ghats on a six-factor risk score for the BMC immersion planning officer, linking every data point to its MPPCB report page.',
    category: 'product',
  },
  7: {
    expect: 'ut3av/ImpactLab',
    disposition: 'publish',
    summary:
      'A 3D rule-to-geometry engine with grounded AI explanations and a bilingual voice guide, so clerks can calculate setbacks and see compliant building massing.',
    category: 'product',
  },
  8: {
    expect: 'shriomverma100/Pran-Vayu',
    disposition: 'publish',
    summary:
      'Turns three years of MPPCB water tests into a ranked action plan for Bhopal’s seven ghats, with field sheets and a brief in Hindi and English.',
    category: 'product',
  },
  9: {
    expect: 'MishraAbhishek1999/hackthon',
    disposition: 'publish',
    summary:
      'Turns MPPCB water-quality reports into structured data and ranks Bhopal’s seven immersion ghats on CPCB Class B risk triggers, with bilingual field briefs.',
    category: 'product',
  },
  10: {
    expect: 'NarayanRajput09/Visharjan-Ghat',
    disposition: 'publish',
    summary:
      'A web platform that helps people find visarjan ghat locations and information to plan their visits.',
    category: 'product',
    notes: [
      'P10 is "Track 2", the track’s problem statement (only two were set) — published as written',
    ],
  },
  11: {
    expect: 'PriyanshuRaj2077/Bhumi-Vikas-Sahayak',
    disposition: 'publish',
    summary:
      'Helps municipal clerks find and understand Madhya Pradesh building regulations, answering in Hindi and English with exact rule references and PDF pages.',
    category: 'product',
  },
  12: {
    expect: 'anukalptripathi532-spec/Jal-Nirikshak',
    disposition: 'publish',
    summary:
      'Checks three years of MPPCB ghat water tests against CPCB bathing limits and ranks Bhopal’s seven ghats by risk, with a one-page Hindi and English brief.',
    category: 'product',
  },
  13: {
    expect: '-eng/visarjan-ghat-watch',
    disposition: 'publish',
    summary:
      'An interactive map of Bhopal’s visarjan sites showing water quality before, during and after immersion across 2023–2025, with a one-page site report.',
    category: 'product',
  },
  14: {
    expect: '1011/bhuvikas',
    disposition: 'publish',
    summary:
      'A Madhya Pradesh building-regulation assistant that extracts the relevant clauses, checks building parameters and flags potential violations with references.',
    category: 'product',
  },
  15: {
    expect: 'rishabhsahu747422-star/visarjan-ghat',
    disposition: 'publish',
    summary:
      'Separates three problems in MPPCB’s ghat data — pollution before immersion, damage during it, poor recovery a week later — and the action each one needs.',
    category: 'product',
  },
  16: {
    expect: '06/Neel-Tarang',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s ghats on one screen, separating water that was already bad before immersion from water that gets worse during it, with a reason for each.',
    category: 'product',
  },
  17: {
    expect: 'bitCrafterDS/visarjan-ghat-watch',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven visarjan ghats by water-test risk against CPCB limits, with Hindi and English reasons and every number linked to its MPPCB report page.',
    category: 'product',
  },
  18: {
    expect: '12116/KSHITI',
    disposition: 'publish',
    summary:
      'A one-screen tool for the permission clerk: reads a question in English, Hindi or Hinglish, calculates setbacks, FAR and fees in code, and cites the exact rule.',
    category: 'product',
  },
  19: {
    expect: 'priyanxs/ghatwatch',
    disposition: 'publish',
    summary:
      'A monitoring and alert platform for river ghats that tracks parameters such as water levels, safety hazards, crowd density and environmental conditions.',
    category: 'product',
  },
  20: {
    expect: 'inxeoz/2026-10-11-bhopal-impact-sol-11th-oct',
    disposition: 'publish',
    summary:
      'Answers a clerk’s typed or spoken question on the M.P. Bhumi Vikas Rules in English or Hindi with the rule number and quoted text, plus a 3D view of the plot.',
    category: 'product',
  },
  21: {
    expect: '-Tech-45/GhatSheild-AI',
    disposition: 'publish',
    summary:
      'An explainable water-risk platform for visarjan ghats: historical analysis, ghat prioritisation, data-quality checks, sampling plans and reports in one place.',
    category: 'product',
  },
  22: {
    expect: 'humble-sam/Visarjan-Ghat-Watch',
    disposition: 'publish',
    summary:
      'Ranks seven Bhopal ghats against CPCB criteria with plain-language reasons, links each finding to its report page and writes Hindi and English briefings.',
    category: 'product',
  },
  23: {
    expect: 'arzynx/Claude-Impact-lab-11-oct',
    disposition: 'publish',
    summary:
      'A bilingual rule-reference site: a clerk gets a plot checklist, asks rule questions in English or Hindi and sees the rule, its source text and PDF page.',
    category: 'product',
  },
  24: {
    expect: 'milendrakumarbaghel/visarjan-ghat-watch',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven immersion ghats by water-quality risk from 1,524 MPPCB readings, with English and Hindi reasons and every number opening its PDF page.',
    category: 'product',
    notes: ['O24 is the track’s name; titles are published as written (decided 2026-10-17, 14:57)'],
  },
  25: {
    expect: 'RavendraPatel09/claude-impact-lab-oct11',
    disposition: 'publish',
    summary:
      'A land development assistance platform: a government-style dashboard and an AI chatbot that explains building rules from the available source documents.',
    category: 'product',
  },
  26: {
    expect: 'TheRaj200/-Bhumi-Vikas-Sahayak-Frotnend',
    disposition: 'publish',
    summary:
      'Building-rule help for Bhopal in Hindi, English or Hinglish: source-backed answers, rule search and preliminary compliance checks of 2D building plans.',
    category: 'product',
    notes: ['T26 lists two repositories (frontend and backend); the first is the repository link'],
  },
  27: {
    expect: 'adityasoni-0555/jaldrishti-bhopal-2026',
    disposition: 'publish',
    summary:
      'A bilingual platform comparing 2023–2025 water quality across seven Bhopal immersion ghats, with emergency contacts and ghat-readiness checklists.',
    category: 'product',
  },
  28: {
    expect: 'black-swas/bhumi-vikas-sahayak',
    disposition: 'publish',
    summary:
      'A hallucination-guarded query system that answers land-rule questions only from the rulebook and refuses questions outside its scope.',
    category: 'product',
  },
  29: {
    expect: '1-hue/bhopal_jal_drishti',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven immersion ghats by risk, says where to send oxygen pumps, cleaning staff and testing, and writes Hindi and English WhatsApp briefs.',
    category: 'product',
  },
  30: {
    expect: 'kakarot07-git/bhopal-bhumi-vikas-sahayak',
    disposition: 'publish',
    summary:
      'Answers questions about the official rules document, with all the details in one place, an easy summary and easy access to the documents offline.',
    category: 'product',
  },
  31: {
    expect: 'uttampandeyy987-gif/visarjan-ghat-watch',
    disposition: 'hold',
    summary: 'A solution for polluted rivers.',
    category: 'product',
    holds: [
      'problem and description: P31 is only "Track 2" and Q31 is one line — ask the team what the project does',
    ],
  },
  32: {
    expect: '-0005/niyamsathi',
    disposition: 'publish',
    summary:
      'A rule-backed answering tool for Bhopal permission clerks: each answer gives the rule, table and page and the source wording, with a to-scale plot diagram.',
    category: 'product',
    notes: [
      'same team label as row 11; a recurring label does not make them the same project — kept separate',
    ],
  },
  33: {
    expect: 'utkarshgupta188/aeronerds-CI',
    disposition: 'publish',
    summary:
      'A bilingual workspace for the BMC permission clerk: setbacks and fees come from table lookups, and answers cite the exact rule, clause and PDF page.',
    category: 'product',
  },
  34: {
    expect: '2005hub/Water-Quality-Overview',
    disposition: 'publish',
    summary:
      'Designed to extract dissolved oxygen and BOD readings from reports, compare them with official standards and chart pollution trends across Bhopal’s ghats.',
    category: 'product',
  },
  35: {
    expect: 'NimitSharma869/Oct-2026-Claude-Community-Bhopal',
    disposition: 'hold',
    summary: 'An interactive dashboard to parse, filter and view large amounts of data.',
    category: 'product',
    holds: [
      'title: O35 is "Jail Drishti" but the deployment is named jaldrishti — confirm the project name',
    ],
    links: { live: 'https://jaldrishti-lyart.vercel.app/' },
    notes: [
      'U35 read "vercal.app"; corrected to vercel.app (decided 2026-10-17) — the corrected URL loaded (200) in the importer’s link check on 2026-10-17',
    ],
  },
  36: {
    expect: 'AnoopShukla-ProjectWorld/claude-community-bhopal',
    disposition: 'publish',
    summary:
      'Scores Bhopal’s seven immersion sites 0–100 from 1,524 MPPCB tests of DO, BOD and pH, with sliders that re-weight the ranking.',
    category: 'product',
  },
  37: {
    expect: 'adilrehman786/ghatpulse-mp',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven immersion ghats for attention from 2023–2025 water-quality records, with traceable evidence, data-gap detection and bilingual reports.',
    category: 'product',
  },
  38: {
    expect: 'avisinghdotdev/GhatPehredaar',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s seven ghats against CPCB Class B bathing limits and says whether each fails before, during or a week after immersion.',
    category: 'product',
    withholdTeamLabel: true,
    notes: [
      'E38 is a URL, not a team name — not published; E49 holds the same text, and the rows are different projects — kept separate',
    ],
  },
  39: {
    expect: 'crystalcoderz/ghatvisarjan',
    disposition: 'publish',
    summary:
      'A WhatsApp chatbot for BMC field officers and a web dashboard: it routes them to the nearest permitted artificial ghat and rates water risk against CPCB limits.',
    category: 'product',
  },
  40: {
    expect: 'shivsingh78/NiyamSetu',
    disposition: 'publish',
    summary:
      'An evidence-first assistant for Madhya Pradesh’s Bhumi Vikas Rules that retrieves the relevant rule records and explains them with references and citations.',
    category: 'product',
  },
  41: {
    expect: '29it059-gif/bhumi-vikas-sahayak',
    disposition: 'publish',
    summary:
      'A bilingual web app for the MP Bhumi Vikas Rules, 2012: ask about setbacks, height limits or parking norms for direct answers with links to the official PDFs.',
    category: 'product',
  },
  42: {
    expect: 'Lesjer-kun/NeerNiti',
    disposition: 'publish',
    summary:
      'Ranks seven Bhopal ghats on dissolved oxygen, BOD and pH against CPCB Class B criteria, flags missing data and writes a Hindi-English action brief.',
    category: 'product',
  },
  43: {
    expect: '-inloop/Visarjan-claude-impact-lab',
    disposition: 'publish',
    summary:
      'Sorts Bhopal’s seven ghats into risk tiers on CPCB Class B standards for the BMC planning officer, with every score linked to its MPPCB report page.',
    category: 'product',
  },
  44: {
    expect: 'vermaanv01-boop/bhumi-vikas-sahayak',
    disposition: 'publish',
    summary:
      'A building-rule assistant: clerks ask in plain Hindi or English for source-backed answers, with a visual buildability simulator and a building-plan pre-check.',
    category: 'product',
  },
  45: {
    expect: '-570/visarjan-ghat-watch',
    disposition: 'publish',
    summary:
      'A festival-pollution platform for MPPCB: immersion sites on a map, readings compared with limits, alerts, and citizens’ reports tracked to resolution.',
    category: 'product',
  },
  46: {
    expect: 'AWS-env/bhumi-vikas-sahayak',
    disposition: 'publish',
    summary:
      'A web chat, with a WhatsApp bot in progress, where a permission clerk asks about the MP Bhumi Vikas Rules in English or Hindi and the search finds the rule.',
    category: 'product',
  },
  47: {
    expect: 'r3ban-hub/ghatseva-by-tech-pookies',
    disposition: 'publish',
    summary:
      'A decision-support dashboard for Bhopal’s visarjan ghats with rankings and evidence tables, plus action plans, draft work orders and post-immersion briefs.',
    category: 'product',
  },
  48: {
    expect: 'shanumakode/Safal',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s immersion ghats by pollution risk on CPCB Class B criteria, highlighting hotspots and data gaps to prioritise testing and cleaning.',
    category: 'product',
  },
  49: {
    expect: 'gauravshivhare-prj/Impact-lab',
    disposition: 'hold',
    summary:
      'A decision-support web app that prioritises seven Bhopal ghats by rule-based analysis of water-quality threshold exceedances, recurring concerns and data coverage, with source-linked evidence.',
    category: 'product',
    withholdTeamLabel: true,
    holds: [
      'title: O49 is "GhatRakshak" but the narrative (P49, Q49) and the deployment call it GhatWatch — confirm the project name',
    ],
    notes: ['E49 is a URL, not a team name — not published'],
  },
  50: {
    expect: '1327/X-factor',
    disposition: 'publish',
    summary:
      'Turns three years of buried water-test PDFs into a ranked list of Bhopal’s immersion ghats, with plain reasons, traceable numbers and a Hindi and English brief.',
    category: 'product',
  },
  51: {
    expect: '-oss/Environmental-Operation-System',
    disposition: 'hold',
    summary:
      'A water-quality risk assessment platform that ranks seven Bhopal ghats by evidence-based priority from 2023–2025 MPPCB data, explaining each rank with measurements and report pages.',
    category: 'product',
    holds: [
      'title: O51 is "JalDrishti AI" but the narrative (P51, Q51) calls it "Visarjan Ghat Watch — Jal Rakshak AI" — confirm the project name',
    ],
  },
  52: {
    expect: 'abhaysahu403/visarjan-ghat-watch',
    disposition: 'publish',
    summary:
      'A role-based platform that checks MPPCB ghat data against CPCB criteria in code, ranks ghats for review and drafts action briefs that a person reviews.',
    category: 'product',
    notes: [
      'the narrative (P52, Q52) calls the platform "Ghat Sentinel"; the submitted name (O52) is used',
    ],
  },
  53: {
    expect: 'tejasavnema12/hackathon-project',
    disposition: 'publish',
    summary:
      'A three-tab dashboard that answers the BMC officer’s question, "Where do I send what, before 20 October?", ranking ghats by readings outside CPCB limits.',
    category: 'product',
  },
  54: {
    expect: 'jayeshrajani/NeerSetu',
    disposition: 'publish',
    summary:
      'Ranks Bhopal’s immersion ghats for re-testing against CPCB Class B thresholds, linking every number to its observation, CSV line and report page.',
    category: 'product',
  },
  55: {
    expect: 'Fahadkhan9/Nirmaan-Sahayak-AI',
    disposition: 'publish',
    summary:
      'The clerk types one sentence in Hindi or English; Claude extracts the plan’s numbers and code checks them against the rules, citing the rule and page.',
    category: 'product',
    usageFromNarrative: true,
    notes: [
      'S55 is "Yes", not an answer — how Claude was used is taken from the team’s own sentences in Q55',
    ],
  },
  56: {
    expect: 'aniruddhss/niyamsetu',
    disposition: 'publish',
    summary:
      'Answers building-rule queries in Hindi and English, highlights the exact source passages, generates evidence reports and says when the rules cannot answer.',
    category: 'product',
  },
  57: {
    expect: 'FirstRacer/bhumi-vikas-sahayak',
    disposition: 'dropped',
    holds: [
      'same team label and members as row 61, with a different title and links — decided 2026-10-17: one project, the later row (61) is kept and this row is not imported',
    ],
  },
  58: {
    expect: 'U-jjwal/CLAUDE_HACKATHON',
    disposition: 'publish',
    summary:
      'Turns MPPCB PDF reports into one website that puts Bhopal’s seven ghats into action tiers on DO, BOD and pH, showing each reading’s report year and page.',
    category: 'product',
  },
  59: {
    expect: 'sumitrec/doorabove',
    disposition: 'publish',
    summary:
      'An AI-powered land assistance platform that helps citizens understand land-related information and procedures, step by step and in accessible language.',
    category: 'product',
    notes: [
      'the solution text (Q59) also calls the platform "PlotSaathi"; the submitted name (O59) is used',
    ],
  },
  60: {
    expect: 'harshshrivastava24/Impact-lab-bhumi-vikas',
    disposition: 'hold',
    summary:
      'A retrieval-augmented (RAG) tool for checking the rules when constructing a new building.',
    category: 'product',
    holds: [oneLine(60)],
  },
  61: {
    expect: 'shvezkvmcvxgylvfwk3b34.streamlit.app',
    disposition: 'publish',
    summary: 'Takes a user’s question and answers it according to the rule book.',
    category: 'product',
    notes: [
      'row 57 (same team) is not imported: decided 2026-10-17, one project, this later row kept',
    ],
  },
  62: {
    expect: 'raushanr64/Bhumi-Vikas-Sahayak-AI-Powered-Building-Rules-Assistant',
    disposition: 'publish',
    summary:
      'Answers building questions from the rulebook in English, Hindi and Hinglish with rule numbers and PDF pages, matching each quotation to the original text.',
    category: 'product',
  },
  63: {
    expect: 'Paramdubey/nirmalghat',
    disposition: 'publish',
    summary:
      'A dashboard that ranks seven Bhopal ghats by pollution concern against CPCB standards, maps them and explains each rank with references to the reports.',
    category: 'product',
    notes: [
      'the solution text (Q63) calls the platform "Visarjan Ghat Watch"; the submitted name (O63) is used',
    ],
  },
  64: {
    expect: 'sankatghat.freebuff.app',
    disposition: 'publish',
    summary:
      'A bilingual prototype that turns 1,524 MPPCB readings from seven Bhopal ghats into a pre-visarjan brief: which ghats to review or sample first, and why.',
    category: 'product',
  },
  65: {
    expect: 'anubhavg2210/bhumi-vikas-shayak-claude-impact-lab',
    disposition: 'publish',
    summary:
      'An AI assistant for BMC staff, architects and plot owners that answers English or Hindi questions on the MP Bhumi Vikas Rules with rule and page citations.',
    category: 'product',
  },
  66: {
    expect: 'shaketraj156-ops/green-Visargan',
    disposition: 'publish',
    summary:
      'Turns 1,524 ghat readings into two priority lists, one for recorded pollution and one for missing evidence that needs fresh testing, each with its reading.',
    category: 'product',
    notes: [
      'the solution text (Q66) calls the platform "Visarjan Ghat Watch"; the submitted name (O66) is used',
    ],
  },
  67: {
    expect: '-Develops/Bhumi-Vikas-Sahayak',
    disposition: 'publish',
    summary:
      'A chatbot where anyone can ask about Bhopal’s building regulations in Hindi or English and get simple answers with the rule number and page reference.',
    category: 'product',
    usageFromNarrative: true,
    notes: [
      'S67 repeats the form’s question — how Claude was used is taken from the team’s own sentences in Q67 and R67, which state none',
      'R67 calls the project "RuleSetu"; the submitted name (O67) is used',
    ],
  },
  68: {
    expect: 'lokeshh1312/Sahayak-dost-Ai',
    disposition: 'hold',
    summary: 'A platform that gives information about the rules in the rule book within a click.',
    category: 'product',
    holds: [oneLine(68)],
  },
  69: {
    expect: 'kumarranjankr06-spec/bhumi_vikas',
    disposition: 'publish',
    summary:
      'Gives the building-permission counter clerk a cited answer from the 108-page MP Bhumi Vikas Rules, 2012, and says when the rules give no clear answer.',
    category: 'product',
  },
};
