// SPDX-License-Identifier: Elastic-2.0
//
// Per-staff upload route (/:staffId): resolves the chosen staff member from
// the public card list, then renders the shared upload form.

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { api } from '../api-client';
import { UploadForm } from '../components/UploadForm';

interface StaffCard {
  id: string;
  name: string;
  title: string | null;
  hasHeadshot: boolean;
}

export function Intake(): JSX.Element {
  const { staffId } = useParams<{ staffId: string }>();
  const [staff, setStaff] = useState<StaffCard | null | 'missing'>(null);

  useEffect(() => {
    let alive = true;
    api<{ staff: StaffCard[] }>('/staff')
      .then((r) => {
        if (!alive) return;
        setStaff(r.staff.find((s) => s.id === staffId) ?? 'missing');
      })
      .catch(() => {
        if (alive) setStaff('missing');
      });
    return () => {
      alive = false;
    };
  }, [staffId]);

  if (staff === null) {
    return <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>;
  }
  if (staff === 'missing') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ fontSize: 14 }}>That contact isn&apos;t available for document intake.</p>
        <Link to="/" style={{ fontSize: 13, color: tokens.color.accent }}>
          ← Choose a contact
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Link to="/" style={{ fontSize: 12, color: tokens.color.accent }}>
        ← Choose a different contact
      </Link>
      <UploadForm targetStaffId={staff.id} staffName={staff.name} />
    </div>
  );
}
