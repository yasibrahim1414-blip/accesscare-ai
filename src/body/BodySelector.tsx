import React, { useState } from 'react';
import { Body3DView } from './Body3DView';
import { Body2DMap } from './Body2DMap';
import { BODY_REGIONS, REGION_GROUPS, regionLabel } from '../domain/bodyRegions';
import { Banner } from '../ui/components';
import { useApp } from '../app/AppContext';

type Mode = '3d' | '2d' | 'list';


export function RegionList({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="stack" role="group" aria-label={'Choose body areas from a list'}>
      {REGION_GROUPS.map((g) => (
        <div key={g} className="stack" style={{ gap: 8 }}>
          <h3 className="section">{g}</h3>
          <div className="choice-grid">
            {BODY_REGIONS.filter((r) => r.group === g).map((r) => (
              <button key={r.id} className="choice" aria-pressed={selected.includes(r.id)} onClick={() => onToggle(r.id)}>
                {regionLabel(r.id)}<span className="check" aria-hidden>✓</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Interactive selector (patient) or read-only viewer (doctor). */
export function BodySelector({ selected, onChange, readOnly, focus }: {
  selected: string[]; onChange?: (ids: string[]) => void; readOnly?: boolean; focus?: string | null;
}) {
  const { prefs, force2D } = useApp();
  const [failed, setFailed] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(force2D ? '2d' : '3d');
  const effective: Mode = mode === '3d' && failed ? '2d' : mode;
  const toggle = (id: string) => {
    if (!onChange) return;
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const modes: [Mode, string][] = readOnly ? [['3d', '3D'], ['2d', '2D map']] : [['3d', '3D body'], ['2d', '2D map'], ['list', 'List']];

  return (
    <div className="stack">
      <div className="seg" role="group" aria-label={'How to show the body'}>
        {modes.map(([m, l]) => (
          <button key={m} aria-pressed={effective === m} onClick={() => setMode(m)} disabled={m === '3d' && !!failed}>{l}</button>
        ))}
      </div>
      {failed && <Banner kind="warn">{`The 3D view is currently unavailable on this device (${failed}). The 2D map below works the same way.`}</Banner>}
      {effective === '3d' && (
        <>
          <Body3DView selected={selected} onToggle={readOnly ? undefined : toggle} readOnly={readOnly} focus={focus}
            reducedMotion={prefs.reducedMotion} onUnavailable={(r) => setFailed(r)} height={readOnly ? 380 : 430} />
        </>
      )}
      {effective === '2d' && <Body2DMap selected={selected} onToggle={readOnly ? undefined : toggle} readOnly={readOnly} focus={focus} />}
      {effective === 'list' && <RegionList selected={selected} onToggle={toggle} />}
      <div className="row wrap" aria-live="polite" style={{ gap: 6 }}>
        {selected.length === 0
          ? <span className="small muted">{readOnly ? 'No area selected.' : 'No area selected yet.'}</span>
          : selected.map((id) => (
            <span key={id} className="chip teal" data-testid="selected-chip">
              {regionLabel(id)}
              {!readOnly && <button onClick={() => toggle(id)} aria-label={`Remove ${regionLabel(id)}`}>×</button>}
            </span>
          ))}
        {!readOnly && selected.length > 0 && onChange && (
          <button className="link-btn" onClick={() => onChange([])} data-testid="clear-selection">{'Clear all'}</button>
        )}
      </div>
    </div>
  );
}
