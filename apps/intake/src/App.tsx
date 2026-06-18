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
    <Routes>
      {/* The booking page supplies its own heading and isn't about document
          upload, so it omits the intake header/footer chrome. */}
      <Route
        path="/book/:slug"
        element={
          <IntakeLayout bare>
            <Book />
          </IntakeLayout>
        }
      />
      <Route
        path="/"
        element={
          <IntakeLayout>
            <StaffLookup />
          </IntakeLayout>
        }
      />
      <Route
        path="/:staffId"
        element={
          <IntakeLayout>
            <Intake />
          </IntakeLayout>
        }
      />
      <Route
        path="/t/:token"
        element={
          <IntakeLayout>
            <Token />
          </IntakeLayout>
        }
      />
      <Route
        path="*"
        element={
          <IntakeLayout>
            <StaffLookup />
          </IntakeLayout>
        }
      />
    </Routes>
  );
}
