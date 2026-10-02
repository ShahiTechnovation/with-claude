/**
 * add-favicon-images.mjs
 *
 * For every project in the map below that has a url but no image field,
 * inject `image: 'https://www.google.com/s2/favicons?domain=<host>&sz=128'`
 * immediately after the url line.
 *
 * Run: node scripts/add-favicon-images.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectsPath = resolve(__dirname, '../src/data/projects.ts');

let src = readFileSync(projectsPath, 'utf8');
const lines = src.split('\n');
const out = [];
let changed = 0;

// Slugs → hostnames for favicon lookup
const slugToHost = {
  'nyaya': 'nyaya.workwithani.tech',
  'fly-invaders': 'flyinvaders.przknv.cc',
  'synapse-os': 'synapseos-neural.vercel.app',
  'strata': 'strata-puce-ten.vercel.app',
  'suchakai': 'suchakai.vercel.app',
  'dark-soul': 'dark-soul-two.vercel.app',
  'aftershock': 'aftershock-by-coffetiers.vercel.app',
  'aidebugger': 'riyadadlani02.github.io',
  'anuvaa': 'anuvaa.vercel.app',
  'asai': 'fjwrxbcsepqxhvd39dvpve.streamlit.app',
  'bharat-darshan': 'darshan.alokm.com',
  'bundle': 'zugzwang-claude-bundle.in',
  'chikitsa-setu': 'opd-flow-omega.vercel.app',
  'clonex': 'clone-x-eosin.vercel.app',
  'codelantern': 'code-lantern.vercel.app',
  'compute-atlas': 'compute-atlas-pied.vercel.app',
  'coursestudio': 'coursestudio.vercel.app',
  'dating-chat-assistant': 'dating-chat-assistant.vercel.app',
  'distribution': 'web-azure-five-fohgv9130t.vercel.app',
  'drone-simulation': 'drone-simulation-blue.vercel.app',
  'ek-rasta': 'rasta-alpha.vercel.app',
  'fact-knowledge-layer': 'knowledge-fact-layer.vercel.app',
  'fourbysix': 'fourbysix.vercel.app',
  'incidentos': 'incident-os-web.vercel.app',
  'jev-feed': 'jev-feed.viod606.workers.dev',
  'kaksha': 'deepakwadge81.github.io',
  'launchjury': 'namanind.github.io',
  'marketing-co-pilot': 'marketing-copilot-seven.vercel.app',
  'minivoxsetu': 'minivoxsetu.bugbiceps.in',
  'mp-tourism': 'frontend-five-ruddy-47.vercel.app',
  'petbot': 'you-are-working-on-my-petbot.vercel.app',
  'pokix': 'pokix-ten.vercel.app',
  'predraider': 'predraider.vercel.app',
  'ration-setu': 'ration-setu-master.vercel.app',
  'reasoning-arena': 'reasoning-arena.vercel.app',
  'roadwatch-mp': 'pothole.akshat.fun',
  'safe-not-sorry': 'safe-not-sorry.vercel.app',
  'safesphere': 'safesphere-kcas.onrender.com',
  'simpleexplain-ai': 'simplexplain-ai.vercel.app',
  'skill-to-opportunity-graph': 'skill-opportunity-graph.vercel.app',
  'suvidha': 'suvidhaportal.netlify.app',
  'the-machine-archive': 'claude-hackthon.vercel.app',
  'the-mirror': 'sawan-ade.github.io',
  'tracex-vasp': 'tracex-vasp.vercel.app',
  'watchread': 'watchread.vercel.app',
  'whats-the-cost': 'agentcost.wyrdwerk.com',
  'bhasha-hire': 'bhashahire.vercel.app',
  'civictrace': 'civictrace-bhopal.onrender.com',
  'crowd-sense': 'crowdsenseaibhopal-wsjf.vercel.app',
  'digi-ai': 'zenox2-0.vercel.app',
  'disha': 'disha-three.vercel.app',
  // Audit batch new additions
  'pramaan': 'pramaan-yashraj00700s-projects.vercel.app',
  'vandanai': 'vandanai.in',
  'mental-math': 'claude-hackathon-two.vercel.app',
  'vidbook-global': 'bookstudio-apex-stack.vercel.app',
  'flybrain-asteroid-dodge': 'hex-eye.vercel.app',
  'commuteclass': 'build-day-opal.vercel.app',
  'bhopalflow-ai': 'bhopalflow-ai.vercel.app',
  'bhopal-flow': 'bhopal-flow--main.pankaj2006-pm.deno.net',
  'tims': 'tims-monitoring.vercel.app',
  'nagar-setu': 'nagar-setu.streamlit.app',
  // August 2026 lab
  'navdisha': 'navdisha-drab.vercel.app',
  'carbon-miles': 'carbon-miles.vercel.app',
  'jal-drishti': 'jal-drishti-claude-impact-lab.onrender.com',
  'civic-navigator': 'civic-navigator-u4le.vercel.app',
  'drivecheck-bhopal': 'drivecheck-bhopal.vercel.app',
  'crowd-sense-ai': 'crowdsenseaii.netlify.app',
  'swachh-bhopal': 'swachh-bhopal.vercel.app',
  'mycitybhopal': 'claude.404lab.xyz',
  'bhopal-metro-website': 'bhopal-metro-claude-rmxvds7qd-cyansiiiis-projects.vercel.app',
  'eryss': 'eryss.vercel.app',
  'bhojnav': '404-technerds.vercel.app',
  'plugnet-ai': 'plugnet-ai.vercel.app',
  'smart-city': 'smartcity-frontend-3w6y.onrender.com',
  'smart-bhopal': 'smart-bhopal.vercel.app',
  'bhopal-blogs': 'bhopalblogs.netlify.app',
  'vaani-ai': 'vaani-frontend-hgd1.vercel.app',
  'mp-civic-connect': 'claude-hackathon-flame.vercel.app',
  'meetup-buddy': 'meetup-buddy-git-main-sourabhnamdev9981s-projects.vercel.app',
  'queueless': 'queueless-b2igh5xae-lohareshikhaj19-7420s-projects.vercel.app',
  'bhopal-tourism': 'bhopal-tourism-ten.vercel.app',
  'yieldcompass': 'yield-compass-frontend.vercel.app',
  'spiderweb': 'ayushrai-hub.github.io',
  'the-mirror-2': 'sawan-ade.github.io',
  'tracex-vasp-2': 'tracex-vasp.vercel.app',
  'roadwatch-mp-2': 'pothole.akshat.fun',
};

// State machine: track which slug we're inside
let currentSlug = null;
let hasImage = false;
let blockDepth = 0;
let inProjectsArray = false;

// We'll do a two-pass approach: parse, then emit with insertions
// Pass 1: build list of (lineIndex, slug, hasImage) tuples for each project block
const projectBlocks = []; // { start, end, slug, hasImage, urlLine }

let i = 0;
while (i < lines.length) {
  const line = lines[i];
  
  // Detect slug line
  const slugMatch = line.match(/^\s+slug:\s+'([^']+)'/);
  if (slugMatch) {
    currentSlug = slugMatch[1];
    hasImage = false;
  }
  
  // Detect image field
  if (currentSlug && /^\s+image:/.test(line)) {
    hasImage = true;
  }
  
  // Detect url line  
  const urlMatch = line.match(/^(\s+)url:\s+'([^']+)'/);
  if (urlMatch && currentSlug && !hasImage && slugToHost[currentSlug]) {
    const indent = urlMatch[1];
    const host = slugToHost[currentSlug];
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
    
    out.push(line);
    out.push(`${indent}image: '${faviconUrl}',`);
    changed++;
    
    // Mark as done so we don't double-inject
    hasImage = true;
    i++;
    continue;
  }
  
  // Reset on closing brace of a project object (heuristic: line is just `  },` or `  }`)
  if (/^\s{2}\},?\s*$/.test(line)) {
    currentSlug = null;
    hasImage = false;
  }
  
  out.push(line);
  i++;
}

writeFileSync(projectsPath, out.join('\n'), 'utf8');
console.log(`Done. Injected favicon image fields for ${changed} projects.`);
