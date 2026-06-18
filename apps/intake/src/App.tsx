// SPDX-License-Identifier: Elastic-2.0
//
// Public document-intake SPA. Three routes, no auth:
//   /            — staff lookup grid (pick who to send to)
//   /:staffId    — upload/scan form for a chosen staff member
//   /t/:token    — tokenized "send-a-link" entry (pre-bound recipient)
//
// Phase B ships the shell + routing + a live API health check. Phase C
// fills the card grid, upload form, and PWA scanner.

import { Routes, Route } from 'react-router-dom';

import { IntakeLayout } from './pages/IntakeLayout';
import { StaffLookup } from './pages/StaffLookup';
import { Intake } from './pages/Intake';
import { Token } from './pages/Token';
import { Book } from './pages/Book';

export function App(): JSX.Element {
  return (
    <IntakeLayout>
      <Routes>
        <Route path="/" element={<StaffLookup />} />
        <Route path="/:staffId" element={<Intake />} />
        <Route path="/t/:token" element={<Token />} />
        <Route path="/book/:slug" element={<Book />} />
        <Route path="*" element={<StaffLookup />} />
      </Routes>
    </IntakeLayout>
  );
}
