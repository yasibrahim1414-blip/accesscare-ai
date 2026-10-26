// AI Intent Bridge contract. The demo implementation is deterministic rules;
// a production implementation calls the server-side function in
// supabase/functions/intent-bridge (the API key never ships in the app).
// Both must follow the same rules: never diagnose, never invent details,
// keep unanswered items marked as unanswered.

import type {
  ClarificationAnswer, CommunicationPreferences, Sensation, StructuredReport, SymptomDetails,
} from '../../domain/types';

export interface BridgeInput {
  regionIds: string[];
  sensations: Sensation[];
  details: SymptomDetails;
}

export interface BridgeOption {
  label: string;
  /** text recorded in the report when chosen */
  reportValue: string;
  icon?: string; // visual hint for "visual options" preference
}

export interface BridgeQuestion {
  id: string;
  text: string;
  format: 'yes_no' | 'choice' | 'text';
  options?: BridgeOption[];
  /** why the bridge is asking — shown to the patient for transparency */
  reason: string;
}

export interface IntentBridge {
  readonly kind: 'demo-rules' | 'ai-provider';
  readonly label: string;
  generateQuestions(input: BridgeInput, prefs: CommunicationPreferences): Promise<BridgeQuestion[]>;
  buildReport(input: BridgeInput, answers: ClarificationAnswer[]): StructuredReport;
  renderSummary(report: StructuredReport, prefs: CommunicationPreferences): string;
}
