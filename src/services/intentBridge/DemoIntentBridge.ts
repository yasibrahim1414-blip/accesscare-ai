// Deterministic, rule-based Intent Bridge used in demo mode.
// It is NOT an AI model and is labeled as such in the UI.

import type {
  ClarificationAnswer, CommunicationPreferences, ReportField, StructuredReport,
} from '../../domain/types';
import { SENSATION_LABELS } from '../../domain/types';
import { REGION_BY_ID, regionLabel } from '../../domain/bodyRegions';
import type { BridgeInput, BridgeOption, BridgeQuestion, IntentBridge } from './IntentBridge';

const YES_NO = (yes: string, no: string): BridgeOption[] => [
  { label: 'Yes', reportValue: yes, icon: '👍' },
  { label: 'No', reportValue: no, icon: '👎' },
];

const ONSET_OPTIONS: BridgeOption[] = [
  { label: 'Just now / today', reportValue: 'Today', icon: '⏱️' },
  { label: '1–3 days ago', reportValue: '1–3 days ago', icon: '📅' },
  { label: 'About a week ago', reportValue: 'About a week ago', icon: '🗓️' },
  { label: 'Longer than that', reportValue: 'More than a week ago', icon: '⌛' },
];

const SEVERITY_OPTIONS: BridgeOption[] = [
  { label: 'Mild', reportValue: 'Mild (patient chose "mild")', icon: '🙂' },
  { label: 'Moderate', reportValue: 'Moderate (patient chose "moderate")', icon: '😐' },
  { label: 'Severe', reportValue: 'Severe (patient chose "severe")', icon: '😣' },
];

const COMES_AND_GOES = /comes and goes|on and off|sometimes|intermittent|now and then/i;

const sensationText = (input: BridgeInput) =>
  input.sensations.filter((s) => s !== 'not_sure')
    .map((s) => (s === 'other' && input.details.otherSensation ? input.details.otherSensation : SENSATION_LABELS[s].toLowerCase()));

const regionPhrase = (ids: string[]) =>
  ids.length === 0 ? 'this area' : ids.length === 1 ? `your ${regionLabel(ids[0]).toLowerCase()}` : 'the areas you chose';

/** pairs like knee_l + knee_r */
const bilateralBases = (ids: string[]) => {
  const bases = ids.filter((id) => id.endsWith('_l')).map((id) => id.slice(0, -2));
  return bases.filter((b) => ids.includes(`${b}_r`));
};

export class DemoIntentBridge implements IntentBridge {
  readonly kind = 'demo-rules' as const;
  readonly label = 'Demo mode — rule-based questions (no AI model connected)';

  async generateQuestions(input: BridgeInput, prefs: CommunicationPreferences): Promise<BridgeQuestion[]> {
    const short = prefs.simpleText || prefs.shortSentences;
    const yn = prefs.yesNoQuestions && !prefs.multipleChoice; // yes/no only mode
    const qs: BridgeQuestion[] = [];
    const d = input.details;
    const feel = sensationText(input);
    const what = feel.length ? feel.join(' and ') : 'this feeling';
    const where = regionPhrase(input.regionIds);

    if (input.sensations.includes('other') && !d.otherSensation) {
      qs.push({ id: 'other_desc', format: 'text', reason: 'You chose "Other" without describing it.',
        text: short ? 'What does it feel like?' : 'You chose "Other". Can you describe what it feels like, in a few words?' });
    }

    const named = input.sensations.filter((s) => s !== 'not_sure');
    if (input.sensations.includes('not_sure') && named.length > 0) {
      const list = named.map((s) => SENSATION_LABELS[s].toLowerCase()).join(' and ');
      qs.push({ id: 'confirm_sensation', format: 'yes_no', reason: 'You chose "Not sure" and a specific feeling.',
        options: YES_NO(`Patient confirmed: ${list}`, `Patient is unsure about: ${list}`),
        text: short ? `Is it ${list}?` : `You chose "Not sure" and also "${list}". Does "${list}" describe it?` });
    }

    if (!d.onset) {
      qs.push(yn
        ? { id: 'onset', format: 'yes_no', reason: 'When it started was not given.', options: YES_NO('Started today', 'Started before today'),
            text: short ? 'Did it start today?' : `Did the ${what} start today?` }
        : { id: 'onset', format: 'choice', reason: 'When it started was not given.', options: ONSET_OPTIONS,
            text: short ? 'When did it start?' : `When did the ${what} begin?` });
    }

    if (!d.pattern) {
      qs.push({ id: 'pattern', format: yn ? 'yes_no' : 'choice', reason: 'Whether it is constant was not given.',
        options: yn ? YES_NO('Constant', 'Comes and goes')
          : [{ label: 'All the time', reportValue: 'Constant', icon: '➖' }, { label: 'It comes and goes', reportValue: 'Comes and goes', icon: '〰️' }],
        text: short ? 'Is it there all the time?' : 'Is it there all the time, or does it come and go?' });
    } else if (d.pattern === 'constant' && d.description && COMES_AND_GOES.test(d.description)) {
      qs.push({ id: 'pattern_conflict', format: 'yes_no', reason: 'Your note and your answer about timing may not match.',
        options: YES_NO('Constant (confirmed)', 'Comes and goes (corrected by patient)'),
        text: short ? 'Is it there all the time?' : 'You said it is there all the time, but your note says it comes and goes. Is it there all the time?' });
    }

    if (d.severity === undefined && named.length > 0) {
      qs.push(yn
        ? { id: 'severity', format: 'yes_no', reason: 'How strong it is was not given.', options: YES_NO('Patient said it is severe', 'Patient said it is not severe'),
            text: short ? 'Is it very strong?' : `Is the ${what} very strong?` }
        : { id: 'severity', format: 'choice', reason: 'How strong it is was not given.', options: SEVERITY_OPTIONS,
            text: short ? 'How strong is it?' : `How strong is the ${what}?` });
    }

    if (input.regionIds.some((id) => REGION_BY_ID[id]?.limb)) {
      qs.push({ id: 'extent', format: yn ? 'yes_no' : 'choice', reason: 'Which part of the area is affected was not given.',
        options: yn ? YES_NO('Whole area', 'One specific spot')
          : [{ label: 'The whole area', reportValue: 'Whole area', icon: '⬛' }, { label: 'One spot', reportValue: 'One specific spot', icon: '📍' }],
        text: short ? (yn ? 'Is it the whole area?' : 'Whole area or one spot?')
          : yn ? `Does it affect all of ${where}?` : `Does it affect all of ${where}, or one specific spot?` });
    }

    const both = bilateralBases(input.regionIds);
    if (both.length) {
      qs.push({ id: 'both_sides', format: 'yes_no', reason: 'You selected the same area on both sides.',
        options: YES_NO('Feels the same on both sides', 'Feels different on each side'),
        text: short ? 'Same on both sides?' : 'You chose both sides. Does it feel the same on both sides?' });
    }

    if (!d.description) {
      qs.push({ id: 'anything_else', format: 'text', reason: 'Optional — only if you want to add something.',
        text: short ? 'Anything else for your doctor?' : 'Is there anything else you would like your doctor to know? (optional)' });
    }
    return qs;
  }

  buildReport(input: BridgeInput, answers: ClarificationAnswer[]): StructuredReport {
    const d = input.details;
    const ans = (id: string) => answers.find((a) => a.questionId === id);
    const fields: ReportField[] = [];
    const flags: string[] = [];

    const fromAnswer = (label: string, id: string, existing?: string) => {
      if (existing) { fields.push({ label, value: existing, status: 'confirmed' }); return; }
      const a = ans(id);
      if (a?.status === 'answered' && a.value) fields.push({ label, value: a.value, status: 'confirmed' });
      else if (a?.status === 'unsure') fields.push({ label, value: 'Patient is not sure', status: 'unsure' });
      else fields.push({ label, value: 'Not specified', status: 'unanswered' });
    };

    // sensations, including the "not sure" check
    const sensations = input.sensations.map((s) =>
      s === 'other' ? `Other${d.otherSensation ? `: ${d.otherSensation}` : ''}` : SENSATION_LABELS[s]);
    const other = ans('other_desc');
    if (input.sensations.includes('other') && !d.otherSensation) {
      if (other?.status === 'answered' && other.value) {
        const i = sensations.findIndex((x) => x.startsWith('Other'));
        sensations[i] = `Other: ${other.value}`;
      }
    }
    const confirm = ans('confirm_sensation');
    if (confirm) {
      if (confirm.status === 'answered' && confirm.value?.startsWith('Patient confirmed')) {
        fields.push({ label: 'Sensation check', value: confirm.value, status: 'confirmed' });
      } else if (confirm.status === 'answered') {
        fields.push({ label: 'Sensation check', value: confirm.value!, status: 'unsure' });
      } else {
        fields.push({ label: 'Sensation check', value: 'Patient chose "Not sure" and a specific feeling; not clarified', status: 'needs_clarification' });
        flags.push('Patient selected "Not sure" together with a specific sensation.');
      }
    }

    fromAnswer('Onset', 'onset', d.onset);
    if (d.duration) fields.push({ label: 'Duration', value: d.duration, status: 'confirmed' });

    // pattern, with contradiction handling
    const conflict = ans('pattern_conflict');
    if (d.pattern && conflict) {
      if (conflict.status === 'answered' && conflict.value) fields.push({ label: 'Pattern', value: conflict.value, status: 'confirmed' });
      else {
        fields.push({ label: 'Pattern', value: 'Selected "constant", but the note says it comes and goes', status: 'needs_clarification' });
        flags.push('Timing answer and free-text note may not match.');
      }
    } else {
      fromAnswer('Pattern', 'pattern', d.pattern ? (d.pattern === 'constant' ? 'Constant' : 'Comes and goes') : undefined);
    }

    if (input.sensations.some((s) => s !== 'not_sure')) {
      fromAnswer('Severity', 'severity', d.severity !== undefined ? `${d.severity} / 10 (patient-rated)` : undefined);
    }
    if (input.regionIds.some((id) => REGION_BY_ID[id]?.limb)) fromAnswer('Extent', 'extent');
    if (bilateralBases(input.regionIds).length) fromAnswer('Both sides', 'both_sides');

    const extra = ans('anything_else');
    const desc = d.description ?? (extra?.status === 'answered' ? extra.value : undefined);
    fields.push(desc
      ? { label: 'Patient’s own words', value: desc, status: 'confirmed' }
      : { label: 'Patient’s own words', value: 'None provided', status: 'unanswered' });

    return {
      regions: input.regionIds.map(regionLabel),
      sensations,
      fields,
      clarifications: answers,
      flags,
      generatedBy: 'demo-rules',
    };
  }

  renderSummary(report: StructuredReport, prefs: CommunicationPreferences): string {
    const lines: string[] = [];
    lines.push(`Selected region${report.regions.length > 1 ? 's' : ''}: ${report.regions.join(', ') || 'Not specified'}.`);
    lines.push(`Patient-reported sensation${report.sensations.length > 1 ? 's' : ''}: ${report.sensations.join(', ') || 'Not specified'}.`);
    for (const f of report.fields) {
      const tag = f.status === 'confirmed' ? '' : f.status === 'unsure' ? ' [unsure]' : f.status === 'needs_clarification' ? ' [needs clarification]' : ' [not answered]';
      lines.push(`${f.label}: ${f.value}${tag}.`.replace(/\.\.$/, '.'));
    }
    const unanswered = report.fields.filter((f) => f.status === 'unanswered').map((f) => f.label);
    lines.push(unanswered.length ? `Not yet provided: ${unanswered.join(', ')}.` : 'All follow-up questions were answered.');
    if (!prefs.simpleText) lines.push('This summary records what the patient reported. It is not a diagnosis.');
    return lines.join('\n');
  }
}
