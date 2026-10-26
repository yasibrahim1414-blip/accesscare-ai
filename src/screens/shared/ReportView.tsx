import React from 'react';
import type { FieldStatus, StructuredReport } from '../../domain/types';

const TAG: Record<FieldStatus, string> = {
  confirmed: 'Confirmed', unanswered: 'Not answered', unsure: 'Unsure', needs_clarification: 'Needs clarification',
};

export function StatusTag({ s }: { s: FieldStatus }) {
  return <span className={`tag ${s}`}>{TAG[s]}</span>;
}

export function ReportView({ report }: { report: StructuredReport }) {
  return (
    <dl className="report" style={{ margin: 0 }} data-testid="report">
      <div className="r"><dt>Selected region{report.regions.length > 1 ? 's' : ''}</dt><dd>{report.regions.join(', ') || 'Not specified'}</dd></div>
      <div className="r"><dt>Reported sensation{report.sensations.length > 1 ? 's' : ''}</dt><dd>{report.sensations.join(', ') || 'Not specified'}</dd></div>
      {report.fields.map((f) => (
        <div className="r" key={f.label}><dt>{f.label}</dt><dd>{f.value}<StatusTag s={f.status} /></dd></div>
      ))}
    </dl>
  );
}

export function ClarificationList({ report }: { report: StructuredReport }) {
  if (!report.clarifications.length) return <p className="small muted">No follow-up questions were needed.</p>;
  return (
    <div className="list">
      {report.clarifications.map((a) => (
        <div key={a.questionId} className="list-item" style={{ cursor: 'default', display: 'block' }}>
          <div className="small muted">{a.question}</div>
          <div style={{ fontWeight: 700 }}>
            {a.status === 'answered' ? a.value : a.status === 'unsure' ? 'Not sure' : 'Skipped (not answered)'}
          </div>
        </div>
      ))}
    </div>
  );
}
