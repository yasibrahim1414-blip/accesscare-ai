import React, { useState } from 'react';
import { LuSiren, LuCopy } from 'react-icons/lu';
import { EMERGENCY_NUMBERS } from '../../services/safety';
import { Button, Sheet, copyText } from '../../ui/components';
import { useApp } from '../../app/AppContext';

export function EmergencyContent({ reasons }: { reasons?: string[] }) {
  const { toast } = useApp();
  return (
    <div className="stack" data-testid="emergency">
      <div className="banner danger" role="alert">
        <LuSiren aria-hidden />
        <div className="stack" style={{ gap: 6 }}>
          <b style={{ fontSize: '1.1em' }}>This may need urgent medical help.</b>
          <span>Please call your local emergency number now, or ask someone near you to call. Don’t wait for a reply in this app.</span>
          {reasons && reasons.length > 0 && <span className="small">You told us: {reasons.join('; ')}.</span>}
        </div>
      </div>
      <p className="small muted">AccessCare AI can’t tell whether you are safe and does not give a diagnosis. Messages here are not monitored in real time.</p>
      <div className="stack" style={{ gap: 8 }}>
        {EMERGENCY_NUMBERS.map((n) => (
          <div key={n.region + n.number} className="num-row">
            <div><div style={{ fontWeight: 700 }}>{n.region}</div><div className="small muted">{n.label}</div></div>
            <div className="row" style={{ gap: 6 }}>
              <b>{n.number}</b>
              <button className="iconbtn" aria-label={`Copy ${n.number}`} onClick={async () => toast((await copyText(n.number)) ? `Copied ${n.number}` : `Dial ${n.number} on your phone`)}><LuCopy /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Always-available urgent help button + sheet. */
export function UrgentHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="urgent-btn" onClick={() => setOpen(true)} aria-haspopup="dialog"><LuSiren aria-hidden /> Urgent</button>
      {open && (
        <Sheet title="Urgent help" onClose={() => setOpen(false)}>
          <EmergencyContent />
          <Button variant="secondary" block onClick={() => setOpen(false)}>Close</Button>
        </Sheet>
      )}
    </>
  );
}
