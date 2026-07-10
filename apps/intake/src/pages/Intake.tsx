// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-staff upload route (/:staffId): resolves the chosen staff member from
// the public card list, then renders the shared upload form.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../api-client';
import { UploadForm } from '../components/UploadForm';
import { palette } from '../ui';

interface StaffCard {
  id: string;
  name: string;
  title: string | null;
  hasHeadshot: boolean;
}

export function Intake(): JSX.Element {
  const { staffId } = useParams<{ staffId: string }>();
  const navigate = useNavigate();
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
    return <p style={{ fontSize: 14, color: palette.muted }}>Loading…</p>;
  }
  if (staff === 'missing') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ fontSize: 15, color: palette.text }}>
          That contact isn&apos;t available for document intake.
        </p>
        <Link to="/" style={{ fontSize: 14, color: palette.accent, textDecoration: 'none' }}>
          ← Choose a contact
        </Link>
      </div>
    );
  }

  return (
    <UploadForm
      targetStaffId={staff.id}
      staffName={staff.name}
      onChangeContact={() => navigate('/')}
    />
  );
}
