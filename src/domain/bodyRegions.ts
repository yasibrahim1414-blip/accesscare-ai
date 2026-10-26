// Body regions shared by the 3D model, the 2D fallback map and the list picker.
// Convention: the patient's LEFT side is +x in 3D (figure faces the viewer),
// so in a front view the patient's left appears on the viewer's right.

export type Side = 'left' | 'right' | 'center';

export interface BodyRegion {
  id: string;
  label: string;
  group: string;
  side: Side;
  /** limb regions get an "entire area vs one spot" clarification question */
  limb: boolean;
}

const center = (id: string, label: string, group: string, limb = false): BodyRegion =>
  ({ id, label, group, side: 'center', limb });

const paired = (base: string, label: string, group: string, limb = true): BodyRegion[] => [
  { id: `${base}_l`, label: `Left ${label}`, group, side: 'left', limb },
  { id: `${base}_r`, label: `Right ${label}`, group, side: 'right', limb },
];

export const BODY_REGIONS: BodyRegion[] = [
  center('head', 'Head', 'Head & neck'),
  center('face', 'Face', 'Head & neck'),
  center('neck', 'Neck', 'Head & neck'),
  center('chest', 'Chest', 'Torso'),
  ...paired('abdomen', 'abdomen', 'Torso', false),
  center('upper_back', 'Upper back', 'Torso'),
  center('lower_back', 'Lower back', 'Torso'),
  ...paired('shoulder', 'shoulder', 'Arms'),
  ...paired('upper_arm', 'upper arm', 'Arms'),
  ...paired('elbow', 'elbow', 'Arms'),
  ...paired('forearm', 'forearm', 'Arms'),
  ...paired('wrist', 'wrist', 'Arms'),
  ...paired('hand', 'hand', 'Arms'),
  ...paired('hip', 'hip', 'Legs', false),
  ...paired('thigh', 'thigh', 'Legs'),
  ...paired('knee', 'knee', 'Legs'),
  ...paired('lower_leg', 'lower leg', 'Legs'),
  ...paired('ankle', 'ankle', 'Legs'),
  ...paired('foot', 'foot', 'Legs'),
];

export const REGION_BY_ID: Record<string, BodyRegion> =
  Object.fromEntries(BODY_REGIONS.map((r) => [r.id, r]));

export const regionLabel = (id: string): string => REGION_BY_ID[id]?.label ?? id;

export const REGION_GROUPS = ['Head & neck', 'Torso', 'Arms', 'Legs'];

const AR_BASE: Record<string, string> = {
  head: 'الراس', face: 'الوش', neck: 'الرقبة', chest: 'الصدر', abdomen: 'البطن', upper_back: 'الضهر من فوق', lower_back: 'الضهر من تحت',
  shoulder: 'الكتف', upper_arm: 'الدراع من فوق', elbow: 'الكوع', forearm: 'الساعد', wrist: 'الرسغ', hand: 'الإيد',
  hip: 'الورك', thigh: 'الفخد', knee: 'الركبة', lower_leg: 'الساق', ankle: 'الكاحل', foot: 'القدم',
};
const AR_GROUP: Record<string, string> = { 'Head & neck': 'الراس والرقبة', Torso: 'الجذع', Arms: 'الدراعين', Legs: 'الرجلين' };
/** Region label in the screen's language (Arabic or English). */
export function regionLabelIn(id: string, lang: 'en' | 'ar' = 'en'): string {
  if (lang === 'en') return regionLabel(id);
  const r = REGION_BY_ID[id]; const base = id.replace(/_(l|r)$/, '');
  const name = AR_BASE[base] ?? regionLabel(id);
  return r?.side === 'left' ? `${name} الشمال` : r?.side === 'right' ? `${name} اليمين` : name;
}
export const groupLabelIn = (g: string, lang: 'en' | 'ar' = 'en') => (lang === 'ar' ? AR_GROUP[g] ?? g : g);
