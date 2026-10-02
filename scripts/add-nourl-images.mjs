/**
 * add-nourl-images.mjs
 *
 * For projects with no url AND no image, inject curated Unsplash images
 * based on the project's topic/category.
 *
 * We use direct Unsplash photo URLs (CC0 / Unsplash License, free for any use).
 *
 * Run: node scripts/add-nourl-images.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectsPath = resolve(__dirname, '../src/data/projects.ts');

// Curated Unsplash photo IDs matched to each project's theme.
// Format: https://images.unsplash.com/photo-<ID>?w=400&fit=crop&auto=format
const slugToImage = {
  // BharatVRsh — virtual museum, Indian heritage 3D
  'bharatvrsh':
    'https://images.unsplash.com/photo-1548013146-72479768bada?w=400&fit=crop&auto=format',
  // Contextual Alarms — Android calendar/alarm app
  'contextual-alarms':
    'https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=400&fit=crop&auto=format',
  // Didi — pantry & diet Android app
  'didi':
    'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=400&fit=crop&auto=format',
  // Don't Touch Twice — logic puzzle game
  'dont-touch-twice':
    'https://images.unsplash.com/photo-1606167668584-78701c57f13d?w=400&fit=crop&auto=format',
  // Existential Crisis Debugger — Python terminal debugging tool
  'existential-crisis-debugger':
    'https://images.unsplash.com/photo-1555949963-ff9fe0c870eb?w=400&fit=crop&auto=format',
  // Founder Arena — AI startup advisory
  'founder-arena':
    'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=400&fit=crop&auto=format',
  // Headroom MP — grid headroom research for data centres
  'headroom-mp':
    'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?w=400&fit=crop&auto=format',
  // Hisaab — Android UPI ledger
  'hisaab':
    'https://images.unsplash.com/photo-1589666564459-93cdd3ab856a?w=400&fit=crop&auto=format',
  // JARVIS — holographic 3D design AI
  'jarvis':
    'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400&fit=crop&auto=format',
  // Luma Event Keys Dispenser — event portal
  'luma-event-keys-dispenser':
    'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=400&fit=crop&auto=format',
  // minivt — 2D renderer / graphics experiment
  'minivt':
    'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=400&fit=crop&auto=format',
  // RAKFILE — project scanner / security
  'rakfile':
    'https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=400&fit=crop&auto=format',
  // Rote Learning — NCERT physics labs offline
  'rote-learning':
    'https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=400&fit=crop&auto=format',
  // SpiderWeb — LinkedIn network graph
  'spiderweb':
    'https://images.unsplash.com/photo-1611532736597-de2d4265fba3?w=400&fit=crop&auto=format',
  // JOBG — AI job matching India
  'jobg':
    'https://images.unsplash.com/photo-1586281380349-632531db7ed4?w=400&fit=crop&auto=format',
  // PathPilot — career learning path navigator
  'pathpilot':
    'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=400&fit=crop&auto=format',
  // Safai SenseX — civic cleanliness monitoring
  'safai-sensex':
    'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&fit=crop&auto=format',
  // SakshamPath — inclusive learning for differently abled
  'sakshampath':
    'https://images.unsplash.com/photo-1588072432836-e10032774350?w=400&fit=crop&auto=format',
  // Scam Security Assistant — fraud detection
  'scam-security-assistant':
    'https://images.unsplash.com/photo-1614064641938-3bbee52942c7?w=400&fit=crop&auto=format',
  // ScamShield — real-time scam detection
  'scamshield':
    'https://images.unsplash.com/photo-1518770660439-4636190af475?w=400&fit=crop&auto=format',
  // SortX — AI waste sorting
  'sortx':
    'https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?w=400&fit=crop&auto=format',
  // TrustX — digital trust/verification layer
  'trustx':
    'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=400&fit=crop&auto=format',
  // Vidhyapaath — AI personalized education India
  'vidhyapaath':
    'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=400&fit=crop&auto=format',
  // What Should I Learn Next — learning recommendation
  'what-should-i-learn-next':
    'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=400&fit=crop&auto=format',
  // workob.in — skilled worker platform
  'workob-in':
    'https://images.unsplash.com/photo-1521791136064-7986c2920216?w=400&fit=crop&auto=format',
};

let src = readFileSync(projectsPath, 'utf8');
const lines = src.split('\n');
const out = [];
let changed = 0;

let currentSlug = null;
let hasImage = false;
let hasUrl = false;
let slugLine = -1;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  const slugM = line.match(/^\s+slug:\s+'([^']+)'/);
  if (slugM) {
    currentSlug = slugM[1];
    hasImage = false;
    hasUrl = false;
  }

  if (currentSlug && /^\s+image:/.test(line)) hasImage = true;
  if (currentSlug && /^\s+url:/.test(line)) hasUrl = true;

  // Inject after `repoUrl:` line for no-url projects
  const repoM = line.match(/^(\s+)repoUrl:\s+'([^']+)'/);
  if (repoM && currentSlug && !hasUrl && !hasImage && slugToImage[currentSlug]) {
    const indent = repoM[1];
    out.push(line);
    out.push(`${indent}image: '${slugToImage[currentSlug]}',`);
    hasImage = true;
    changed++;
    continue;
  }

  // Reset on closing brace
  if (/^\s{2}\},?\s*$/.test(line)) {
    currentSlug = null;
    hasImage = false;
    hasUrl = false;
  }

  out.push(line);
}

writeFileSync(projectsPath, out.join('\n'), 'utf8');
console.log(`Done. Injected Unsplash images for ${changed} no-url projects.`);
