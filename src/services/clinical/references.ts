// Reference catalog for the Clinical Intelligence Engine.
// Only public pages whose content was checked when this list was written
// (October 2026). The AI may cite these ids only — it can never add a
// citation of its own, so a reference shown to the doctor is never invented.
// These are patient-facing NHS pages describing when urgent help is needed;
// they are not clinical guidelines and are not a validation of this software.

export interface Reference { id: string; title: string; publisher: string; url: string; covers: string }

export const REFERENCES: Reference[] = [
  { id: 'nhs_stroke', title: 'Symptoms of a stroke (FAST)', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/stroke/symptoms/', covers: 'Face drooping, arm weakness or numbness, speech problems: call 999.' },
  { id: 'nhs_headache', title: 'Headaches — when to get help', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/headaches/', covers: 'Headache with weakness/numbness, sudden extreme pain, difficulty speaking, confusion, loss of vision, non-fading rash, high temperature with stiff neck: call 999. With vomiting or vision problems: urgent GP / 111.' },
  { id: 'nhs_meningitis', title: 'Meningitis — symptoms', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/meningitis/symptoms/', covers: 'Sudden fever, stiff neck, severe worsening headache, light sensitivity, vomiting, confusion, non-fading rash.' },
  { id: 'nhs_chest_pain', title: 'Chest pain', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/chest-pain/', covers: 'Sudden chest pain that does not go away, spreading to arm/neck/jaw/back, or with sweating, nausea, light-headedness or breathlessness: call 999.' },
  { id: 'nhs_breathless', title: 'Shortness of breath', publisher: 'NHS', url: 'https://www.nhs.uk/symptoms/shortness-of-breath/', covers: 'Severe breathing difficulty, chest tightness, blue/grey lips, sudden confusion: call 999.' },
  { id: 'nhs_fainting', title: 'Fainting', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/fainting/', covers: 'Call 999 if not recovering, trouble speaking or moving, chest pain or irregular heartbeat, fainting during exercise, seizure.' },
  { id: 'nhs_stomach', title: 'Stomach ache', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/stomach-ache/', covers: 'Sudden or severe stomach ache, vomiting blood, bloody or black stool, breathing trouble or chest pain: call 999 / A&E.' },
  { id: 'nhs_sepsis', title: 'Sepsis', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/sepsis/', covers: 'Very fast breathing, confusion or slurred speech, blue/blotchy skin, very high or low temperature, non-fading rash: call 999.' },
  { id: 'nhs_suicide', title: 'Help for suicidal thoughts', publisher: 'NHS', url: 'https://www.nhs.uk/mental-health/feelings-symptoms-behaviours/behaviours/help-for-suicidal-thoughts/', covers: 'If someone has seriously harmed themselves or may be about to: call 999 or go to A&E.' },
  { id: 'nhs_anaphylaxis', title: 'Anaphylaxis', publisher: 'NHS', url: 'https://www.nhs.uk/conditions/anaphylaxis/', covers: 'Sudden swelling of lips, mouth, throat or tongue, struggling to breathe, tight throat, blue/grey skin, sudden confusion or fainting: call 999. A raised, itchy or swollen rash can be a symptom.' },
  { id: 'openfda_label', title: 'openFDA — Drug labeling', publisher: 'U.S. FDA', url: 'https://open.fda.gov/apis/drug/label/', covers: 'Manufacturer drug labels (SPL). FDA states openFDA must not be relied on for medical decisions and the reformatted content is not FDA-verified.' },
];

export const REF_BY_ID: Record<string, Reference> = Object.fromEntries(REFERENCES.map((r) => [r.id, r]));
export const validRefs = (ids: unknown): string[] => (Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!REF_BY_ID[x]))].slice(0, 4) : []);
