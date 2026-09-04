import type { FaqItem, ParticipationPath, Partner, SocialLink } from './types';

export const site = {
  /** The brand, as it is written. */
  name: 'With Claude',
  /** The brand, as it is set. Used wherever the wordmark is typographic. */
  wordmark: 'WITH CLAUDE',
  domain: 'www.withclaude.in',
  url: 'https://www.withclaude.in',

  /** The manifesto. One line, and it is the loudest thing on the site. */
  manifesto: 'India is building.',

  /** The descriptor. What this is, in one sentence. */
  descriptor: 'Where people across India meet, learn, experiment and build with Claude.',

  /** The positioning line, for search results and social cards. */
  positioning: "India's community for people building, learning and experimenting with Claude.",

  description:
    "India's community for people building, learning and experimenting with Claude. Find events, cities, builders and projects across the country.",

  /**
   * Legal precision. This is a community *around* Claude, organised by the
   * people in it. It is not an Anthropic property, an official Anthropic
   * programme, or an endorsed representative of one — and the copy must never
   * imply otherwise. Do not soften this line without checking with Anthropic.
   */
  affiliation:
    'An independent, volunteer-run community of people who build with Claude. Not affiliated with, endorsed by, or operated by Anthropic. Claude and Anthropic are trademarks of Anthropic PBC.',

  /**
   * The one place the Ambassador relationship is explained. Rendered wherever
   * someone is about to assume this site can make them an Ambassador.
   */
  ambassadorNote:
    'Claude Community Ambassadors are appointed by Anthropic. Applications go through Anthropic — not through this site.',

  locale: 'en_IN',
  timezone: 'Asia/Kolkata',
} as const;

/**
 * Official destinations.
 *
 * `ambassadorProgramUrl` is the confirmed home of the Claude Community
 * Ambassador programme, and it is required rather than optional: every
 * "Become an Ambassador" CTA on this site goes there and nowhere else. Typing
 * it as a plain `string` is what removes the possibility of a fallback — a
 * generic anthropic.com link would leave someone who wants to host events
 * navigating for the page themselves.
 */
export const official: {
  ambassadorProgramUrl: string;
  anthropic: string;
  claude: string;
} = {
  ambassadorProgramUrl: 'https://claude.com/community/ambassadors',
  anthropic: 'https://www.anthropic.com',
  claude: 'https://claude.ai',
};

export const socials: SocialLink[] = [
  { label: 'Telegram', url: 'https://t.me/+wItpj8Qh-kszNzA1' },
  { label: 'Instagram', url: 'https://www.instagram.com/theoriginguild' },
  { label: 'X', url: 'https://x.com/Claude_In_' },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/company/theoriginguild' },
];

/** The channel where the community actually talks. Used as a real fallback. */
export const communityChannel = {
  label: 'Telegram',
  url: 'https://t.me/+wItpj8Qh-kszNzA1',
};

/**
 * How the record is maintained.
 *
 * A public record is only worth trusting if it says how it can be wrong and
 * what happens when it is. This is the honest version: the site is run by
 * volunteers, corrections come through the channel the community already
 * uses, and there is no claim of an editorial desk that does not exist.
 *
 * `maintainers` deliberately names organisations rather than individuals.
 * Nobody's name goes on this site as a maintainer until they have said they
 * want it there.
 */
export const stewardship = {
  /** Who keeps the record. Organisations only, and only real ones. */
  maintainers: [
    {
      name: 'The Origin Guild',
      role: 'Organises the community events in Bhopal and supplies the event record and photography',
      url: 'https://t.me/tog_guild',
    },
  ],
  /** Where a correction goes. A real channel, read by real people. */
  corrections: communityChannel,
  /**
   * The correction policy, in the order the steps actually happen. Rendered
   * verbatim — if a step here is not true, change the process, not the copy.
   */
  correctionSteps: [
    'Tell us what is wrong and, where you can, how you know. A link, a photograph or a name is enough.',
    'Anything factual that cannot be checked comes down while it is being checked, rather than staying up with a note on it.',
    'A record that turns out to be wrong is corrected or removed. It is not quietly edited into something else.',
    'Anyone listed here can ask to have their entry changed or taken down, and it comes down.',
  ],
} as const;

export const partners: Partner[] = [
  {
    id: 'ptr-origin-guild',
    slug: 'the-origin-guild',
    status: 'published',
    name: 'The Origin Guild',
    role: 'Organises community events in Bhopal',
    url: 'https://t.me/+wItpj8Qh-kszNzA1',
    citySlug: 'bhopal',
  },
  {
    id: 'ptr-builder-base',
    slug: 'builder-base',
    status: 'published',
    name: 'Builder Base',
    role: 'Co-hosted the Claude Code Impact Lab',
    citySlug: 'bhopal',
  },
  {
    id: 'ptr-aic-rntu',
    slug: 'aic-rntu-foundation',
    status: 'published',
    name: 'AIC-RNTU Foundation',
    role: 'Venue, Claude Code Workshop (vol. 09)',
    citySlug: 'bhopal',
  },
];

/**
 * Ways in.
 *
 * Note what is *not* here: there is no path that lets a visitor start a
 * chapter. Hosting Claude Community events is an Anthropic programme, so the
 * HOST path routes to Anthropic and says so. Everything else is genuinely open
 * to anyone.
 *
 * The three Tally forms are live and were created by the Bhopal organisers.
 * The two `submission` paths are handled on-site by `SubmitPanel`. Each names a
 * form in `forms.ts` by id and nothing else: the anchor the CTA scrolls to is
 * read off that form, so an id that does not resolve fails the build rather
 * than quietly pointing at a panel that is not there.
 */
export const participationPaths: ParticipationPath[] = [
  {
    id: 'attend',
    label: 'Attend',
    title: 'Find an event',
    description:
      'Every event so far has been free and open, with registration by approval. Start with whatever is next on the calendar.',
    ctaLabel: 'See what is on',
    kind: 'internal',
    url: '/events',
  },
  {
    id: 'build',
    label: 'Build',
    title: 'Submit what you made',
    description:
      'Anything you built with Claude — a product, an agent, a tool, a weekend experiment. Submissions are reviewed before they are published.',
    ctaLabel: 'Add your build',
    kind: 'submission',
    formId: 'build',
  },
  {
    id: 'contribute',
    label: 'Contribute',
    title: 'Add yourself to the builder index',
    description:
      'Say who you are, where you are, and what you are building. This is an open index, not an appointment — anyone building with Claude can be in it.',
    ctaLabel: 'Add yourself',
    kind: 'submission',
    formId: 'contribute',
  },
  {
    id: 'speak',
    label: 'Speak',
    title: 'Give a talk or a demo',
    description:
      'Run a session, walk a room through something you built, or mentor a team through a build day.',
    ctaLabel: 'Submit a talk',
    kind: 'external',
    url: 'https://tally.so/r/Y5lNo6',
    tallyId: 'Y5lNo6',
  },
  {
    id: 'volunteer',
    label: 'Volunteer',
    title: 'Help run the room',
    description:
      'Check-in, stage, photographs, and the unglamorous work that makes a room feel welcoming.',
    ctaLabel: 'Join the crew',
    kind: 'external',
    url: 'https://tally.so/r/D46gXj',
    tallyId: 'D46gXj',
  },
  {
    id: 'partner',
    label: 'Partner',
    title: 'Bring a venue or a community',
    description:
      'Share a space, co-run a session, or bring your members along. Campuses, communities and workspaces welcome.',
    ctaLabel: 'Collaborate',
    kind: 'external',
    url: 'https://tally.so/r/dWeBZy',
    tallyId: 'dWeBZy',
  },
  {
    id: 'host',
    label: 'Host',
    title: 'Lead Claude Community events',
    description:
      'Claude Community events are hosted by Claude Community Ambassadors. It is a programme Anthropic runs, and the application goes to them.',
    ctaLabel: 'Become an Ambassador',
    kind: 'official',
    note: site.ambassadorNote,
  },
];

export const faq: FaqItem[] = [
  {
    q: 'Is this run by Anthropic?',
    a: 'No. This is an independent, volunteer-run community of people who build with Claude. Anthropic runs the Claude Community Ambassador programme that some of the events here are hosted under, but this website is not an Anthropic property and does not speak for them.',
  },
  {
    q: 'Is it free?',
    a: 'Every event on the record so far has been free. Registration is usually by approval, so put your name down early.',
  },
  {
    q: 'Do I need to know how to code?',
    a: 'No. Build days deliberately mix developers with designers, students, and people who simply know a city and its problems well.',
  },
  {
    q: 'What should I bring?',
    a: 'A charged laptop and a charger. Sessions use public data only — no special access needed.',
  },
  {
    q: 'There is nothing happening in my city. What can I do?',
    a: 'Two things, and they are different. You can register interest for your city, which is a signal for where community activity should go next — it is not an application and it does not create a chapter. And if you want to host Claude Community events yourself, that means becoming a Claude Community Ambassador, which is a programme Anthropic runs.',
  },
  {
    q: 'How do I get into the builder index?',
    a: 'Add yourself. Anyone building with Claude in India can submit an entry — it is reviewed before it appears, and being in the index is not the same as being an Ambassador or an organiser.',
  },
  {
    q: 'How do I hear about new dates?',
    a: 'New dates land in the community channel first, and every scheduled event appears on this site the moment it is confirmed.',
  },
];
