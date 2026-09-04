import { cities } from './cities';
import { communityChannel } from './site';

/**
 * Submission forms.
 *
 * There is no backend, and inventing one would be worse than not having one.
 * So a submission is composed in the browser into a clean, complete block of
 * text that the person copies and sends to the organisers through the channel
 * the community actually uses. Nothing is posted anywhere without them doing
 * it, which is also the most honest possible privacy story.
 *
 * When a real endpoint exists, set `endpoint` on a form and the panel posts to
 * it instead. Nothing else has to change.
 *
 * Every form says the same thing at the end: submissions are reviewed before
 * they are published. That is the `pending` state in the data model, made
 * visible to the person filling it in.
 */

export type FieldType = 'text' | 'email' | 'url' | 'textarea' | 'select';

export interface SubmissionField {
  name: string;
  label: string;
  type: FieldType;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
}

export interface SubmissionForm {
  id: string;
  /** Anchor on /join. */
  anchor: string;
  eyebrow: string;
  title: string;
  intro: string;
  submitLabel: string;
  /** The heading of the composed block, so a reviewer can sort submissions. */
  subject: string;
  afterword: string;
  /** A real POST target, when one exists. Undefined → compose-and-send. */
  endpoint?: string;
  fields: SubmissionField[];
}

const cityOptions = [...cities.map((c) => c.name).sort(), 'Somewhere else'];

export const forms: SubmissionForm[] = [
  {
    id: 'contribute',
    anchor: 'contribute',
    eyebrow: 'Contribute',
    title: 'Add yourself to the index',
    intro:
      'Anyone building with Claude in India can be in the builder index. It is not a role and not an appointment — it is a way for people to find each other.',
    submitLabel: 'Compose my entry',
    subject: 'BUILDER SUBMISSION',
    afterword:
      'Entries are reviewed before they are published. Only what you write below is shown — your email is used to reach you and is never displayed.',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Your name' },
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        required: true,
        hint: 'Never published.',
        placeholder: 'you@example.com',
      },
      { name: 'city', label: 'City', type: 'select', required: true, options: cityOptions },
      {
        name: 'role',
        label: 'What you do',
        type: 'text',
        required: true,
        hint: 'Three or four words.',
        placeholder: 'Backend engineer, student, designer…',
      },
      {
        name: 'building',
        label: 'What you are building',
        type: 'textarea',
        required: true,
        hint: 'One or two sentences.',
      },
      {
        name: 'claudeTools',
        label: 'Which Claude tools you use',
        type: 'text',
        placeholder: 'Claude Code, the API, MCP…',
      },
      { name: 'links', label: 'Links', type: 'text', placeholder: 'Site, GitHub, LinkedIn, X' },
    ],
  },
  {
    id: 'build',
    anchor: 'build',
    eyebrow: 'Build',
    title: 'Submit what you made',
    intro:
      'Anything you built with Claude — a product, an agent, a developer tool, a research prototype, a weekend experiment. The interesting part is how Claude was actually used.',
    submitLabel: 'Compose my submission',
    subject: 'PROJECT SUBMISSION',
    afterword:
      'Projects are reviewed before they are published. The archive stays empty rather than being filled with things nobody can verify.',
    fields: [
      {
        name: 'title',
        label: 'Project',
        type: 'text',
        required: true,
        placeholder: 'What you called it',
      },
      {
        name: 'creator',
        label: 'Who built it',
        type: 'text',
        required: true,
        hint: 'You, and anyone you built it with.',
      },
      { name: 'city', label: 'City', type: 'select', required: true, options: cityOptions },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        required: true,
        options: [
          'Product',
          'Agent',
          'Developer tool',
          'Research',
          'Creative',
          'Campus',
          'Experiment',
          'Startup',
        ],
      },
      {
        name: 'summary',
        label: 'What it does',
        type: 'textarea',
        required: true,
        hint: 'One sentence.',
      },
      {
        name: 'claudeUsage',
        label: 'How Claude was used',
        type: 'textarea',
        required: true,
        hint: 'The part worth reading.',
      },
      {
        name: 'url',
        label: 'Link',
        type: 'url',
        placeholder: 'https://',
        hint: 'Live, repo, or a video.',
      },
      {
        name: 'event',
        label: 'Built at an event?',
        type: 'text',
        placeholder: 'Which one, if any',
      },
      { name: 'email', label: 'Email', type: 'email', required: true, hint: 'Never published.' },
    ],
  },
  {
    id: 'practice',
    anchor: 'practice',
    eyebrow: 'Practice',
    title: 'Write up how you use Claude',
    intro:
      'A first-hand account of one real thing you did — the problem, the workflow, what Claude contributed and what you had to fix. Not tips, and not a summary of the docs.',
    submitLabel: 'Compose my write-up',
    subject: 'USE CASE SUBMISSION',
    afterword:
      'Use cases are reviewed before they are published, and every entry carries your name and a reason you would know. Nothing in this library is written by the site.',
    fields: [
      {
        name: 'title',
        label: 'What this is about',
        type: 'text',
        required: true,
        placeholder: 'How I use Claude Code to…',
        hint: 'A sentence about your work, not a headline about Claude.',
      },
      { name: 'name', label: 'Your name', type: 'text', required: true },
      {
        name: 'credential',
        label: 'Why you would know',
        type: 'text',
        required: true,
        placeholder: 'Ran the Claude Code workshop in Bhopal, vol. 09',
        hint: 'Something checkable. This is printed next to your name.',
      },
      { name: 'city', label: 'City', type: 'select', required: true, options: cityOptions },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        required: true,
        options: [
          'Claude Code',
          'Product',
          'Startups',
          'Research',
          'Design',
          'Education',
          'Operations',
          'Marketing',
          'Automation',
          'Agents',
          'Developer workflows',
        ],
      },
      {
        name: 'problem',
        label: 'The problem',
        type: 'textarea',
        required: true,
        hint: 'What was actually in the way. Not a demo scenario.',
      },
      {
        name: 'workflow',
        label: 'The workflow',
        type: 'textarea',
        required: true,
        hint: 'What happened, in order.',
      },
      {
        name: 'claudeDid',
        label: 'What Claude did',
        type: 'textarea',
        required: true,
        hint: 'Specifically. "Helped" is not an answer.',
      },
      {
        name: 'humanDid',
        label: 'What you did',
        type: 'textarea',
        required: true,
        hint: 'The judgement, the corrections, the parts it got wrong.',
      },
      {
        name: 'tools',
        label: 'What you used',
        type: 'text',
        placeholder: 'Claude Code, Claude API',
      },
      {
        name: 'result',
        label: 'The result',
        type: 'textarea',
        required: true,
        hint: 'Including what still does not work.',
      },
      { name: 'email', label: 'Email', type: 'email', required: true, hint: 'Never published.' },
    ],
  },
  {
    id: 'city',
    anchor: 'city',
    eyebrow: 'Your city',
    title: 'Register your city',
    intro:
      'If nothing is happening where you are, say so. This records where people building with Claude actually are, which is the signal that decides where community activity goes next.',
    submitLabel: 'Compose my signal',
    subject: 'CITY INTEREST',
    afterword:
      'This is an interest signal, not an application. It does not create a chapter and it does not make anyone an Ambassador — Claude Community Ambassadors are appointed by Anthropic.',
    fields: [
      { name: 'city', label: 'City', type: 'text', required: true, placeholder: 'Where you are' },
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        required: true,
        hint: 'For updates about your city. Never published.',
      },
      {
        name: 'doing',
        label: 'What you are building',
        type: 'textarea',
        hint: 'Optional, but it makes the signal much more useful.',
      },
      {
        name: 'helping',
        label: 'Would you help grow activity there?',
        type: 'select',
        options: ['Just keep me posted', 'I would help organise', 'I would host a venue'],
      },
    ],
  },
];

export const formById = new Map(forms.map((f) => [f.id, f]));

/** Where a composed submission is sent. The channel the community actually uses. */
export const submissionChannel = communityChannel;
