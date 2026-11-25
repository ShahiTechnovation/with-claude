/**
 * EDITORIAL DECISIONS for the Fable 5.2 Build Day (Bhopal, 22 Nov 2026).
 *
 * One entry per source row, keyed by EXCEL ROW NUMBER (header = row 1) of
 * `Form responses 1`, with October's contract (`../impact-lab-2026-10/editorial.ts`):
 * `expect` ties each decision to its row, so a reordered or revised export
 * fails loudly.
 *
 * Confirmed by Vishal 2026-11-24 (16:58): this table as written; the track (P)
 * is kept as a tag (18:05: the short track name, for search only, never
 * shown); row 18 (Mesh) is held until the team confirms it was built on the
 * day. In a duplicate pair the later row is kept. Held rows are those
 * whose own words do not say what the project does, or that have no public
 * link.
 *
 * The card line (`summary`) comes only from the cells named above it, at most
 * 160 characters, with nothing added. Titles stand as written. Nothing here
 * is private: no email, no member name, no "anything else" note.
 */
import type { LabEditorial } from '../impact-lab-2026-10/editorial';

const oneLine = (row: number) =>
  `description: Q${row} and R${row} are one line each — ask the team for a short description`;

export const BUILD_DAY_NOVEMBER_DECISIONS: Record<number, LabEditorial> = {
  // R2
  2: {
    expect: '/little-hollow',
    disposition: 'hold',
    summary: 'A tiny village simulator.',
    category: 'creative',
    holds: [
      'description: Q2 is the same prompt as Q33 and R2 is one line — ask the team what the project does',
    ],
  },
  // R3
  3: {
    expect: 'MediTech',
    disposition: 'hold',
    summary:
      'A hyperlocal medicine availability finder: search a medicine and see nearby verified chemists by distance, with stock status, price and open/closed status.',
    category: 'product',
    holds: ['title: O3 is "MediTech" but R3 calls it "MedFind Bhopal" — confirm the project name'],
    notes: ['U3 is "NA", not a link'],
  },
  // R4
  4: {
    expect: 'mudra-nu.vercel.app',
    disposition: 'publish',
    summary:
      'For students who want to learn to invest but have no balance: start on the Mudra website, understand how the market works, then open up to stocks and funds.',
    category: 'product',
    usageFromNarrative: true,
    notes: [
      'T4 does not say how Claude was used — taken from the team’s own sentences in R4 and S4, which state none',
    ],
  },
  // S5
  5: {
    expect: 'shooting-game-e.netlify.app',
    disposition: 'publish',
    summary:
      'A 3D first-person wave shooter built with Three.js and vanilla JavaScript in a single HTML file, with synthesized sound effects and no external assets.',
    category: 'creative',
    notes: [
      'Q5 and R5 are one line each; S5 says what the game is',
      'T5 calls the game "NEON VANGUARD"; the submitted name (O5) is used',
    ],
  },
  // Q6–R6
  6: {
    expect: 'roomsync-1-1tbe.onrender.com',
    disposition: 'publish',
    summary:
      'Compares users’ lifestyle preferences and calculates a compatibility score, so students and working professionals find roommates with similar habits.',
    category: 'product',
  },
  // R7
  7: {
    expect: 'universe-gazette.onrender.com',
    disposition: 'publish',
    summary:
      'Turns any "What if...?" premise into the animated front page of a newspaper from that universe, with Claude writing the stories and drawing the photos as SVG.',
    category: 'product',
  },
  8: {
    expect: 'bas hai yar',
    disposition: 'dropped',
    holds: [
      'same repository and a member as row 12, which came later and is fuller — the later row (12) is kept and this row is not imported',
    ],
  },
  // R9
  9: {
    expect: 'raksha-ai-pearl-phi.vercel.app',
    disposition: 'publish',
    summary:
      'An emergency response platform: a bilingual AI assistant (Hindi & English), one-tap SOS with real-time GPS location sharing, and a live response dashboard.',
    category: 'product',
    notes: ['E9 is "Na", not a team name — not published'],
  },
  // Q10–R10
  10: {
    expect: 'tinylivlyvillage.netlify.app',
    disposition: 'publish',
    summary:
      'A real-time browser village simulation in vanilla JavaScript and HTML5 Canvas, where villagers balance hunger, fatigue, jobs, relationships and memory.',
    category: 'creative',
  },
  // R11
  11: {
    expect: 'h2-s-prompt.vercel.app',
    disposition: 'hold',
    summary:
      'An AI solution that makes people aware of AQI, so that they can plan to breathe fresh air.',
    category: 'product',
    holds: [oneLine(11)],
  },
  // R12
  12: {
    expect: '5amps/potato-bot',
    disposition: 'publish',
    summary:
      'A Discord music bot: users play, pause, resume, skip and stop music in a server with simple commands, for a smooth music-listening experience.',
    category: 'product',
    usageFromNarrative: true,
    notes: [
      'row 8 (same repository and a member) is not imported: this later, fuller row is kept',
      'T12 repeats R12 — how Claude was used is taken from the team’s own sentences in R12 and S12, which state none',
    ],
  },
  // R13
  13: {
    expect: '/build-day-fable-5.2',
    disposition: 'hold',
    summary: 'A game, just for fun.',
    category: 'creative',
    holds: ['description: Q13–T13 are a few words each — ask the team what the project does'],
  },
  // Q14–R14 and the title
  14: {
    expect: 'pika-meadow',
    disposition: 'publish',
    summary:
      'An open-world game in a single .html file: good-quality visuals need not be AAA games that need a high-end GPU, as it can use WebGL.',
    category: 'creative',
    notes: ['E14 is "NA", not a team name — not published'],
  },
  // R15
  15: {
    expect: 'Recall Your study',
    disposition: 'hold',
    summary:
      'An AI-powered personal memory assistant that helps users save, organize and retrieve important information from their daily lives using natural language.',
    category: 'product',
    holds: [
      'title: O15 is "Recall Your study" but R15 calls it "RecallMe AI" and T15 "Callme AI" — confirm the project name',
    ],
    notes: ['U15 says the project is under development, with a local prototype — no link'],
  },
  // Q16–R16
  16: {
    expect: 'hollowbrook-1.vercel.app',
    disposition: 'hold',
    summary: 'A village simulation that shows the life of village people.',
    category: 'creative',
    holds: [oneLine(16)],
  },
  // Q17–R17
  17: {
    expect: 'tinyliving.vercel.app',
    disposition: 'hold',
    summary: 'A small village of living beings to watch, just for fun.',
    category: 'creative',
    holds: [oneLine(17)],
  },
  // Q18–R18
  18: {
    expect: 'mesh-eta-one.vercel.app',
    disposition: 'hold',
    summary:
      'An area-specific passive shelter thermal design platform: every thermal number is computed live in the browser by a documented physics engine.',
    category: 'product',
    usageFromNarrative: true,
    holds: [
      'built on the day: R18 calls it "a working prototype for SIH 2026" — waiting for the team to confirm it was built on the day',
    ],
    notes: [
      'Q18 calls the platform "THERMA"; the submitted name (O18) matches the repository and the deployment',
      'T18 does not say how Claude was used — taken from the team’s own sentences in R18 and S18, which state none',
    ],
  },
  // Q19–R19
  19: {
    expect: 'park-sense-ai-prototype-2.vercel.app',
    disposition: 'publish',
    summary:
      'A smart 3D parking system that finds the nearest available slot, books it and navigates to it; Find My Car guides users back with Hindi-English voice commands.',
    category: 'product',
  },
  // Q20–R20
  20: {
    expect: '/Wavokinesis',
    disposition: 'hold',
    summary: 'A hybrid plugin that connects plugins from two worlds to make something new.',
    category: 'product',
    holds: [
      'description: Q20 and R20 do not say what the plugin does — ask the team for a short description',
    ],
  },
  // R21
  21: {
    expect: 'phishguard-production-fc5dee41.up.railway.app',
    disposition: 'publish',
    summary:
      'An AI-powered scanner that checks any suspicious message, email or URL and tells the user within seconds whether it is safe, suspicious or a scam.',
    category: 'product',
    usageFromNarrative: true,
    notes: [
      'R21 calls the project "PhishGuard"; the submitted name (O21) is used',
      'T21 is "yes", not an answer — how Claude was used is taken from the team’s own sentences in R21 and S21, which state none',
    ],
  },
  // R22
  22: {
    expect: '/Tiny-Computer',
    disposition: 'publish',
    summary:
      'An 8-bit computer built from scratch: its own CPU, assembler and emulator, running Snake. Watch registers change and memory light up, in one offline web page.',
    category: 'creative',
  },
  // Q23–R23
  23: {
    expect: '10secthief.vercel.app',
    disposition: 'hold',
    summary: 'A fun game to relax your mind.',
    category: 'creative',
    holds: [oneLine(23)],
  },
  // R24
  24: {
    expect: '/VIdeo-Gen',
    disposition: 'hold',
    summary: 'An AI-based video editing pipeline.',
    category: 'product',
    holds: [oneLine(24)],
  },
  // R25
  25: {
    expect: 'bhopal-rainready.vercel.app',
    disposition: 'publish',
    summary:
      'A free web platform that combines a real simulation engine, community reporting and AI to make Bhopal’s monsoon hazards visible and understandable.',
    category: 'product',
  },
  26: {
    expect: 'scam shield',
    disposition: 'dropped',
    holds: [
      'same repository and members as row 27, which came later — the later row (27) is kept and this row is not imported',
    ],
  },
  // R27
  27: {
    expect: '/ScamShield',
    disposition: 'publish',
    summary:
      'An AI-powered scam detection app for Indian users: paste an SMS or WhatsApp message, or upload a screenshot, to classify it as scam, suspicious or likely safe.',
    category: 'product',
    notes: ['row 26 (same repository and members) is not imported: this later row is kept'],
  },
  // Q28–R28 and the title
  28: {
    expect: 'bhoj-five.vercel.app',
    disposition: 'publish',
    summary:
      'A living Upper Lake to play with: wind and river carry nutrients, algae make oxygen by day and use it at night, and about 300 fish seek oxygen-rich water.',
    category: 'creative',
  },
  // R29
  29: {
    expect: '/bhopal-run',
    disposition: 'publish',
    summary:
      'A browser platformer set in Bhopal: run through Chowk Bazaar, VIP Road and Bada Talab, collect jalebis, dodge autos and cows, and stomp "kachra monsters".',
    category: 'creative',
  },
  30: {
    expect: 'Chill coders',
    disposition: 'dropped',
    holds: [
      'same repository and a member as row 32, which came later and adds a video — the later row (32) is kept and this row is not imported',
    ],
  },
  // R31
  31: {
    expect: '/VillageVerse',
    disposition: 'publish',
    summary:
      'A living village simulation with 12 villagers, each with needs, a profession, personality, memories, opinions and a diary, who work, trade and spread rumours.',
    category: 'creative',
    usageFromNarrative: true,
    notes: [
      'T31 is "no use" and S31 names no Claude model — published as submitted (decided 2026-11-24)',
    ],
  },
  // Q32–R32
  32: {
    expect: '/Tiny-village-game',
    disposition: 'hold',
    summary: 'A game for stress relief.',
    category: 'creative',
    holds: ['description: Q32 and R32 are one or two words — ask the team what the project does'],
    notes: [
      'row 30 (same repository and a member) is not imported: this later row, which adds a video, is kept',
    ],
  },
  // R33
  33: {
    expect: '/Whisperwood',
    disposition: 'hold',
    summary: 'A tiny living village, with some phases still to cover.',
    category: 'creative',
    holds: [
      'description: Q33 is the same prompt as Q2 and R33 is one line — ask the team what the project does',
      'title: O33 is "WishperWood" but the repository is named Whisperwood — confirm the project name',
    ],
  },
  // Q34–R34
  34: {
    expect: '5-min-fix.vercel.app',
    disposition: 'publish',
    summary:
      'A 3D interactive room: choose how you feel or what you need, get one small, achievable real-life task, and the room changes to show your progress.',
    category: 'product',
  },
  // R35
  35: {
    expect: 'chaaya-sable.vercel.app',
    disposition: 'publish',
    summary:
      'A two-player strategy game on a 7x7 board: place a stone, choose a direction; its shadow claims every free cell in that line. Whoever ends with more cells wins.',
    category: 'creative',
    notes: ['R35 calls the game "Chhaya"; the submitted name (O35) matches the deployment'],
  },
  // R36
  36: {
    expect: 'vortex-game-claude-build-day',
    disposition: 'hold',
    summary: 'A simple game for when you’re bored.',
    category: 'creative',
    holds: [oneLine(36)],
  },
  // R37
  37: {
    expect: 'car-rush-three.vercel.app',
    disposition: 'publish',
    summary:
      'A 3D highway driving game in the browser: drive through traffic, avoid collisions, collect coins and unlock cars, with missions, nitro and day and night modes.',
    category: 'creative',
  },
};
