import type { FaqItem, Involvement, Partner, SocialLink } from './types';

export const site = {
  name: 'Claude India',
  shortName: 'Claude India',
  domain: 'claudeindia.in',
  url: 'https://claudeindia.in',
  tagline: 'Where India builds with Claude.',
  headline: 'India is building.',
  description:
    'A community record of the people across India who meet, learn and ship with Claude. Events, cities, builders and projects — in one place.',
  /**
   * Legal precision (brief §30): this is an independent community, not an
   * Anthropic property. This line is rendered in the footer and must not be
   * softened without checking with the organisers.
   */
  affiliation:
    'An independent, non-commercial community of people who build with Claude. Not affiliated with, endorsed by, or operated by Anthropic.',
  locale: 'en_IN',
  timezone: 'Asia/Kolkata',
} as const;

export const socials: SocialLink[] = [
  { label: 'Telegram', url: 'https://t.me/tog_guild' },
  { label: 'Instagram', url: 'https://www.instagram.com/theoriginguild' },
  { label: 'X', url: 'https://x.com/og_guild' },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/company/theoriginguild' },
];

export const partners: Partner[] = [
  {
    id: 'ptr-origin-guild',
    name: 'The Origin Guild',
    role: 'Hosts the Bhopal chapter',
    url: 'https://t.me/tog_guild',
    citySlug: 'bhopal',
  },
  {
    id: 'ptr-builder-base',
    name: 'Builder Base',
    role: 'Co-hosted the Claude Code Impact Lab',
    citySlug: 'bhopal',
  },
  {
    id: 'ptr-aic-rntu',
    name: 'AIC-RNTU Foundation',
    role: 'Venue, Claude Code Workshop (vol. 09)',
    citySlug: 'bhopal',
  },
];

/**
 * Ways in. The three Tally forms are live and were created by the Bhopal
 * chapter; `tallyId` opens them as a popup with the plain URL as a no-JS
 * fallback.
 */
export const involvement: Involvement[] = [
  {
    id: 'attend',
    label: 'Attend',
    title: 'Come to the next one',
    description:
      'Every event is free and open. Registration is by approval on Luma, so put your name down early.',
    ctaLabel: 'See upcoming events',
    url: '/events',
  },
  {
    id: 'host',
    label: 'Host',
    title: 'Start a chapter in your city',
    description:
      'Every open dot on the map is a city where the first Claude event has not happened yet. If you want to run it where you live, say hello in the group.',
    ctaLabel: 'Talk to the organisers',
    url: 'https://t.me/tog_guild',
  },
  {
    id: 'speak',
    label: 'Speak',
    title: 'Give a talk or mentor',
    description:
      'Run a session, walk a room through what you built, or mentor a team through an Impact Lab.',
    ctaLabel: 'Submit a talk',
    url: 'https://tally.so/r/Y5lNo6',
    tallyId: 'Y5lNo6',
  },
  {
    id: 'partner',
    label: 'Partner',
    title: 'Co-host with your community',
    description:
      'Share a venue, co-run a workshop, or bring your members along. Community partners, campuses and spaces welcome.',
    ctaLabel: 'Collaborate',
    url: 'https://tally.so/r/dWeBZy',
    tallyId: 'dWeBZy',
  },
  {
    id: 'volunteer',
    label: 'Volunteer',
    title: 'Join the crew',
    description:
      'Check-in, stage, photos, and the unglamorous work of making a room feel welcoming.',
    ctaLabel: 'Join the crew',
    url: 'https://tally.so/r/D46gXj',
    tallyId: 'D46gXj',
  },
];

export const faq: FaqItem[] = [
  {
    q: 'Is it free?',
    a: 'Yes. Every event so far has been free. Entry is by approval on Luma, so register early.',
  },
  {
    q: 'Do I need to know how to code?',
    a: 'No. Impact Lab teams deliberately mix developers with designers, students, and people who simply know the city and its problems well.',
  },
  {
    q: 'What should I bring?',
    a: 'A charged laptop and a charger. Sessions use public data only — no special access needed.',
  },
  {
    q: 'There is no chapter in my city. Can I start one?',
    a: 'Yes, and that is the fastest way to grow this. Message the organisers on Telegram and they will walk you through how Bhopal did it.',
  },
  {
    q: 'Is this run by Anthropic?',
    a: 'No. This is an independent, non-commercial community of people who build with Claude. It is organised by volunteers, currently through The Origin Guild in Bhopal.',
  },
  {
    q: 'How do I hear about new dates?',
    a: 'New dates and new cities land in the Telegram group first.',
  },
];
