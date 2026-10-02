# Baserow migration — event archive reconciliation

Generated 2026-10-02. Destination: Baserow database 578390 — Projects 1236064, Events 1236080, ProjectCredits 1236082.
Row numbers are Excel rows of `Form responses 1` (header = row 1). Withheld values are referred to by cell coordinate only.

- Real Baserow: every check above ran on the rows as STORED, re-read in full through the API after the import.
- Website column: an isolated LOCAL database clone, synced from those Baserow rows by the normal reconcile/queue — not shared Neon. Production sync is off.
- Default blank rows: events 1 deleted, events 2 deleted, credits 1 deleted, credits 2 deleted (deleted only when blank in every field and unreferenced; restorable from Baserow's trash).

## Counts

| Measure | Count |
| --- | ---: |
| Raw submissions (source rows) | 100 |
| — Impact Lab 2 / Fable 5.1 | 18 / 82 |
| Unique projects (candidates after merging repeats, excluding junk) | 95 |
| Merged repeat submissions | 4 |
| Junk submissions held (quarantined) | 1 |
| Imported into Baserow — new rows created by this import | 94 |
| — of which published | 77 |
| — of which draft, held for review | 17 |
| — of which already a local project through the earlier rehearsal (matched by source key) | 92 |
| Held for review — not imported | 1 |
| Failed | 0 |
| Baserow Projects rows (table total) | 94 |
| Baserow Events rows (table total) | 2 |
| Baserow ProjectCredits rows (table total) | 0 |
| Website (local sync): public | 77 |
| Website (local sync): draft | 17 |

## Read-back verification

| Check | Result | Detail |
| --- | --- | --- |
| events: one row per canonical event, held dates correct | pass | 2 canonical event rows; Impact Lab 2 on 2026-09-15, Fable 5.1 on 2026-09-20 |
| projects: no duplicate source keys | pass | 94 distinct keys on 94 rows |
| projects: every applied candidate exists | pass | 94 of 94 present |
| projects: held candidates were not written | pass | 1 held candidate(s) absent, as planned |
| projects: stored fields equal the planned values | pass | 952 field values compared on 94 rows — all equal |
| projects: long answers keep every character of the source cell | pass | problem, solution and built-with match their workbook cells (whitespace normalised only) |
| projects: Event link resolves to the canonical event | pass | 94 rows linked to the right event row |
| projects: editorial status as planned (held → draft) | pass | published only where publishable and not held |
| credits: no personal credits without consent, none orphaned | pass | 0 credit rows on imported projects; 0 pre-existing blank row(s) left untouched |
| privacy: no emails, phones, credential/local URLs or personal names stored | pass | every stored value scanned — none found |
| sync: every imported row projected; nothing held is public | pass | 94 rows projected |
| reconciliation: every source row has a disposition | pass | 100 of 100 source rows accounted for |

## Bhopal | Claude Code Impact Lab 2 — held 2026-09-15

| Row | Disposition | Title | Baserow row | Earlier local project | Website (local sync) | Reason / notes |
| ---: | --- | --- | ---: | --- | --- | --- |
| 2 | imported — published | SortX | 4 | /projects/sortx/ | published /projects/sortx/ |  |
| 3 | imported as draft — held for review | TIMS | 5 | /projects/tims/ | draft /projects/tims/ | title: the submitted project name (N3) does not match the thermal-monitoring project its repository and deployment describe — confirm the name |
| 4 | imported — published | Scam security assistant | 6 | /projects/scam-security-assistant/ | published /projects/scam-security-assistant/ |  |
| 5 | imported — published | Disha | 7 | /projects/disha/ | published /projects/disha/ |  |
| 6 | imported — published | Safai SenseX | 8 | /projects/safai-sensex/ | published /projects/safai-sensex/ |  |
| 7 | imported — published | CivicTrace | 9 | /projects/civictrace/ | published /projects/civictrace/ |  |
| 8 | imported — published | Digi संरक्षक AI | 10 | /projects/digi-ai/ | published /projects/digi-ai/ |  |
| 9 | imported — published | JOBG | 11 | /projects/jobg/ | published /projects/jobg/ |  |
| 10 | imported — published | What should I learn next? | 12 | /projects/what-should-i-learn-next/ | published /projects/what-should-i-learn-next/ |  |
| 11 | imported — published | Bhasha Hire | 13 | /projects/bhasha-hire/ | published /projects/bhasha-hire/ |  |
| 12 | imported — published | Vidhyapaath | 14 | /projects/vidhyapaath/ | published /projects/vidhyapaath/ |  |
| 13 | imported — published | ScamShield | 15 | /projects/scamshield/ | published /projects/scamshield/ |  |
| 14 | imported — published | Crowd Sense | 16 | /projects/crowd-sense/ | published /projects/crowd-sense/ |  |
| 15 | imported — published | SakshamPath | 17 | /projects/sakshampath/ | published /projects/sakshampath/ |  |
| 16 | imported as draft — held for review | Nagar Setu | 18 | /projects/nagar-setu/ | draft /projects/nagar-setu/ | title: N16 is "R"; confirm "Nagar Setu" (or the correct name) |
| 17 | imported — published | workob in | 19 | /projects/workob-in/ | published /projects/workob-in/ |  |
| 18 | imported — published | TrustX | 20 | /projects/trustx/ | published /projects/trustx/ |  |
| 19 | imported — published | PathPilot | 21 | /projects/pathpilot/ | published /projects/pathpilot/ |  |

## Bhopal | Claude Code Build Day — Fable 5.1 — held 2026-09-20

| Row | Disposition | Title | Baserow row | Earlier local project | Website (local sync) | Reason / notes |
| ---: | --- | --- | ---: | --- | --- | --- |
| 2 | imported — published | Ek Rasta | 22 | /projects/ek-rasta/ | published /projects/ek-rasta/ |  |
| 3 | held — junk submission (quarantined) | — | — | — | — | suspected test entry: every field is placeholder text and neither link is a URL |
| 4 | imported — published | Petbot | 23 | /projects/petbot/ | published /projects/petbot/ |  |
| 5 | imported as draft — held for review | DocsGuard | 24 | /projects/docsguard/ | draft /projects/docsguard/ | title: the narrative says "DocsGuard" but the repository and deployment say "Pramaan" — confirm the project name |
| 6 | imported — published | Safe, Not Sorry | 25 | /projects/safe-not-sorry/ | published /projects/safe-not-sorry/ |  |
| 7 | imported — published | Fact Knowledge Layer | 26 | /projects/fact-knowledge-layer/ | published /projects/fact-knowledge-layer/ |  |
| 8 | held for review — not imported | Headline Threads | — | — | — | possible duplicate of /projects/headline-threads/ (an existing project) — same artifact github.com/tm23-sanji/headline_threads; held: cross-event duplicate: E8 is the repository of the existing Impact Lab 1 project /projects/headline-threads/ — decide whether this is the same project (keep one record) or a distinct Fable build |
| 9 | imported — published | Compute Atlas | 27 | /projects/compute-atlas/ | published /projects/compute-atlas/ |  |
| 10 | imported — published | Ration Setu | 28 | /projects/ration-setu/ | published /projects/ration-setu/ |  |
| 11 | imported — published | Bharat Darshan | 29 | /projects/bharat-darshan/ | published /projects/bharat-darshan/ |  |
| 12 | imported — published | SpiderWeb | 30 | /projects/spiderweb/ | published /projects/spiderweb/ |  |
| 13 | imported — published | RoadWatch MP | 31 | /projects/roadwatch-mp/ | published /projects/roadwatch-mp/ |  |
| 14 | imported — published | nyaya | 32 | /projects/nyaya/ | published /projects/nyaya/ |  |
| 15 | imported — published | Fly Invaders | 33 | /projects/fly-invaders/ | published /projects/fly-invaders/ |  |
| 16 | imported — published | Headroom MP | 34 | /projects/headroom-mp/ | published /projects/headroom-mp/ |  |
| 17 | imported — published | WatchRead | 35 | /projects/watchread/ | published /projects/watchread/ |  |
| 18 | imported — published | Synapse-OS | 36 | /projects/synapse-os/ | published /projects/synapse-os/ |  |
| 19 | imported as draft — held for review | AI-Boosted 5G Advanced Core and Charging | 37 | /projects/ai-boosted-5g-advanced-core-and-charging/ | draft /projects/ai-boosted-5g-advanced-core-and-charging/ | title and description: no project name is stated and F19/G19 are one line each — ask the team for a name and a short description |
| 20 | imported as draft — held for review | Simhastha 2028 platform | 38 | /projects/simhastha-2028-platform/ | draft /projects/simhastha-2028-platform/ | title: no project name is stated; the repository and deployment use different names — confirm the name |
| 21 | imported — published | SuchakAI | 39 | /projects/suchakai/ | published /projects/suchakai/ |  |
| 22 | imported — published | ANUVAA | 40 | /projects/anuvaa/ | published /projects/anuvaa/ |  |
| 23 | imported as draft — held for review | DIC - Developers Integration Console | 41 | — | draft /projects/dic-developers-integration-console/ | no usable public artifact after the link check — ask the team for a public repository, deployment or demo |
| 24 | imported — published | SimpleExplain AI | 42 | /projects/simpleexplain-ai/ | published /projects/simpleexplain-ai/ |  |
| 25 | imported — published | SafeSphere | 43 | /projects/safesphere/ | published /projects/safesphere/ |  |
| 26 | imported — published | Strata | 44 | /projects/strata/ | published /projects/strata/ |  |
| 27 | imported — published | Hisaab | 45 | /projects/hisaab/ | published /projects/hisaab/ |  |
| 28 | imported — published | miniVoxSetu | 46 | /projects/minivoxsetu/ | published /projects/minivoxsetu/ |  |
| 29 | imported — published | IncidentOS | 47 | /projects/incidentos/ | published /projects/incidentos/ |  |
| 30 | imported — published | Chikitsa Setu | 48 | /projects/chikitsa-setu/ | published /projects/chikitsa-setu/ |  |
| 31 | imported as draft — held for review | BhopalFlow AI | 49 | /projects/bhopalflow-ai/ | draft /projects/bhopalflow-ai/ | possible duplicate of row 80 (BHOPAL//FLOW): same team label "Team Eklavya" and both are Bhopal traffic decision-support tools, but they come from different submitters with a different repository and deployment — confirm one project or two before publishing either (not merged on team name) |
| 32 | imported as draft — held for review | Brain Sprint | 50 | /projects/brain-sprint/ | draft /projects/brain-sprint/ | title: the submission uses two names ("Brain Sprint" and "mental+Math") — confirm which |
| 33 | imported as draft — held for review | AI product demo agent | 51 | /projects/ai-product-demo-agent/ | draft /projects/ai-product-demo-agent/ | title: no project name is stated — ask the team for one |
| 34 | imported — published | Reasoning Arena | 52 | /projects/reasoning-arena/ | published /projects/reasoning-arena/ |  |
| 35 | imported — published | fourbysix | 53 | /projects/fourbysix/ | published /projects/fourbysix/ |  |
| 36 | imported — published | YieldCompass | 54 | /projects/yieldcompass/ | published /projects/yieldcompass/ |  |
| 37 | imported — published | CourseStudio | 55 | /projects/coursestudio/ | published /projects/coursestudio/ |  |
| 38 | imported as draft — held for review | AnnaSetu | 56 | /projects/annasetu/ | draft /projects/annasetu/ | title: G38 says "[Project Name]" — confirm "AnnaSetu" or the correct name |
| 39 | imported — published | Luma Event Keys Dispenser | 57 | /projects/luma-event-keys-dispenser/ | published /projects/luma-event-keys-dispenser/ |  |
| 40 | imported — published | Pokix | 58 | /projects/pokix/ | published /projects/pokix/ |  |
| 41 | imported — published | aidebugger | 59 | /projects/aidebugger/ | published /projects/aidebugger/ |  |
| 42 | imported — published | Founder Arena | 60 | /projects/founder-arena/ | published /projects/founder-arena/ |  |
| 43 | imported — published | KAKSHA | 61 | /projects/kaksha/ | published /projects/kaksha/ |  |
| 44 | imported — published | JARVIS | 62 | /projects/jarvis/ | published /projects/jarvis/ |  |
| 45 | imported as draft — held for review | AI credit navigation platform | 63 | — | draft /projects/ai-credit-navigation-platform/ | no usable public artifact: E45 is a localhost address (never visited), D45 is a personal name and no demo was supplied — ask for a public repository, deployment or video; title: no project name is stated |
| 46 | imported — published | predraider | 64 | /projects/predraider/ | published /projects/predraider/ |  |
| 47 | imported — published | TraceX-VASP | 65 | /projects/tracex-vasp/ | published /projects/tracex-vasp/ |  |
| 48 | imported — published | What’s the cost? | 66 | /projects/what-s-the-cost/ | published /projects/what-s-the-cost/ |  |
| 49 | imported — published | CodeLantern | 67 | /projects/codelantern/ | published /projects/codelantern/ |  |
| 50 | imported — published | LaunchJury | 68 | /projects/launchjury/ | published /projects/launchjury/ |  |
| 51 | imported — published | didi | 69 | /projects/didi/ | published /projects/didi/ |  |
| 52 | imported — published | Suvidha | 70 | /projects/suvidha/ | published /projects/suvidha/ |  |
| 53 | imported as draft — held for review | mailsend.dev | 71 | /projects/mailsend-dev/ | draft /projects/mailsend-dev/ | no usable artifact: E53 is a GitHub profile, not a repository, and D53 is a personal name — the narrative points to mailsend.dev; ask the team to confirm it and supply the repository |
| 54 | imported — published | Existential Crisis Debugger | 72 | /projects/existential-crisis-debugger/ | published /projects/existential-crisis-debugger/ |  |
| 55 | imported — published | Contextual Alarms | 73 | /projects/contextual-alarms/ | published /projects/contextual-alarms/ |  |
| 56 | imported — published | Dating Chat Assistant | 74 | /projects/dating-chat-assistant/ | published /projects/dating-chat-assistant/ |  |
| 57 | imported as draft — held for review | AI form-filling service | 75 | /projects/ai-form-filling-service/ | draft /projects/ai-form-filling-service/ | title and description: no clear project name and one-line problem/solution text — ask the team for a name and description |
| 58 | imported — published | Dark Soul | 76 | /projects/dark-soul/ | published /projects/dark-soul/ |  |
| 59 | imported as draft — held for review | VidBook Global | 77 | /projects/vidbook-global/ | draft /projects/vidbook-global/ | title: the narrative says "VidBook Global" but the repository and deployment say "bookstudio" — confirm the project name |
| 60 | imported — published | CloneX | 78 | /projects/clonex/ | published /projects/clonex/ |  |
| 61 | imported — published | Marketing Co-Pilot | 79 | /projects/marketing-co-pilot/ | published /projects/marketing-co-pilot/ |  |
| 62 | imported — published | MP Tourism | 80 | /projects/mp-tourism/ | published /projects/mp-tourism/ |  |
| 63 | imported — published | The Machine Archive | 81 | /projects/the-machine-archive/ | published /projects/the-machine-archive/ |  |
| 64 | imported — published | minivt | 82 | /projects/minivt/ | published /projects/minivt/ |  |
| 65 | imported — published | ASAI | 83 | /projects/asai/ | published /projects/asai/ |  |
| 66 | imported — published | THE MIRROR | 84 | /projects/the-mirror/ | published /projects/the-mirror/ |  |
| 67 | imported — published | AFTERSHOCK | 85 | /projects/aftershock/ | published /projects/aftershock/ |  |
| 68 | imported — published | Skill-to-Opportunity Graph | 86 | /projects/skill-to-opportunity-graph/ | published /projects/skill-to-opportunity-graph/ |  |
| 69 | merged into another submission (row 25) | SafeSphere | 43 | — | — | merged into row 25; same repository and deployment; row 69 adds the demo video and leaves the team label blank (the blank does not erase "BuidX"), and its problem/solution answers are swapped, so row 25’s are used; status: both rows say Fully functional |
| 70 | imported — published | Don’t Touch Twice | 87 | /projects/don-t-touch-twice/ | published /projects/don-t-touch-twice/ |  |
| 71 | imported — published | RAKFILE | 88 | /projects/rakfile/ | published /projects/rakfile/ |  |
| 72 | imported — published | Drone Simulation | 89 | /projects/drone-simulation/ | published /projects/drone-simulation/ |  |
| 73 | imported — published | Distribution | 90 | /projects/distribution/ | published /projects/distribution/ |  |
| 74 | merged into another submission (row 42) | Founder Arena | 60 | — | — | merged into row 42; same repository and submitter; each row supplies a different demo video — row 74’s is primary, row 42’s is kept as a second demo; status: both rows say Fully functional |
| 75 | merged into another submission (row 12) | SpiderWeb | 30 | — | — | merged into row 12; same repository and submitter; the narrative was resubmitted with the functionality answer changed; status: row 75 is the later revision (Partially functional); row 12 said Prototype / demonstration only |
| 76 | imported as draft — held for review | FlyBrain · Asteroid Dodge | 91 | /projects/flybrain-asteroid-dodge/ | draft /projects/flybrain-asteroid-dodge/ | title: the narrative says "FlyBrain · Asteroid Dodge" but the repository and deployment say "HexEye" — confirm the project name |
| 77 | imported — published | Bundle | 92 | /projects/bundle/ | published /projects/bundle/ |  |
| 78 | imported as draft — held for review | Personalised audio lessons | 93 | /projects/personalised-audio-lessons/ | draft /projects/personalised-audio-lessons/ | title: no project name is stated — ask the team for one |
| 79 | merged into another submission (row 55) | Contextual Alarms | 73 | — | — | merged into row 55; same repository and submitter; row 79 adds the demo video (its trailing backslash removed) and revises the problem text; status: both rows say Partially functional |
| 80 | imported as draft — held for review | BHOPAL//FLOW | 94 | /projects/bhopal-flow/ | draft /projects/bhopal-flow/ | possible duplicate of row 31 (BhopalFlow AI): same team label "Team Eklavya" and both are Bhopal traffic decision-support tools, but they come from different submitters with a different repository and deployment — confirm one project or two before publishing either (not merged on team name) |
| 81 | imported — published | Jev Feed | 95 | /projects/jev-feed/ | published /projects/jev-feed/ |  |
| 82 | imported — published | Rote Learning | 96 | /projects/rote-learning/ | published /projects/rote-learning/ |  |
| 83 | imported — published | BharatVRsh | 97 | /projects/bharatvrsh/ | published /projects/bharatvrsh/ |  |
