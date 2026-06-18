// Authored preview — @vibe/ui Wizard
import { tokens, Wizard } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 0,
  fontFamily: tokens.font.body,
  minHeight: 560,
};

const field = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
  marginBottom: 16,
};

const labelStyle = { fontSize: 12, color: tokens.color.textMuted };

const inputStyle = {
  padding: '10px 12px',
  background: tokens.color.bg,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 14,
};

const STEPS = [
  {
    key: 'identity',
    label: 'Client identity',
    content: (
      <div>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: tokens.color.text }}>
          Client identity
        </h3>
        <div style={field}>
          <span style={labelStyle}>Display name</span>
          <div style={inputStyle}>Cedar Holdings, Inc.</div>
        </div>
        <div style={field}>
          <span style={labelStyle}>Entity type</span>
          <div style={inputStyle}>S-Corporation (1120-S)</div>
        </div>
        <div style={field}>
          <span style={labelStyle}>EIN</span>
          <div style={inputStyle}>83-•••••42</div>
        </div>
      </div>
    ),
  },
  {
    key: 'engagement',
    label: 'Engagement',
    content: <div>Engagement defaults…</div>,
  },
  { key: 'billing', label: 'Billing & fees', content: <div>Billing…</div> },
  { key: 'portal', label: 'Portal access', content: <div>Portal…</div> },
  { key: 'review', label: 'Review', content: <div>Review…</div> },
];

export function CreateClient(): JSX.Element {
  return (
    <div style={frame}>
      <Wizard
        open
        title="New client"
        steps={STEPS}
        currentStepKey="identity"
        onStepChange={() => {}}
        onClose={() => {}}
        primaryAction={{ label: 'Save client', onClick: () => {} }}
        secondaryAction={{ label: 'Save draft', onClick: () => {} }}
      />
    </div>
  );
}

export function MidStep(): JSX.Element {
  const steps = [
    { key: 'identity', label: 'Client identity', content: <div>Identity…</div> },
    {
      key: 'billing',
      label: 'Billing & fees',
      content: (
        <div>
          <h3 style={{ margin: '0 0 16px', fontSize: 16, color: tokens.color.text }}>
            Billing & fees
          </h3>
          <div style={field}>
            <span style={labelStyle}>Fee structure</span>
            <div style={inputStyle}>Fixed fee — $3,500 / year</div>
          </div>
          <div style={field}>
            <span style={labelStyle}>Invoice consolidation</span>
            <div style={inputStyle}>Separate per engagement</div>
          </div>
        </div>
      ),
    },
    { key: 'portal', label: 'Portal access', content: <div>Portal…</div> },
  ];
  return (
    <div style={frame}>
      <Wizard
        open
        title="New client"
        steps={steps}
        currentStepKey="billing"
        onStepChange={() => {}}
        onClose={() => {}}
        primaryAction={{ label: 'Save client', onClick: () => {} }}
      />
    </div>
  );
}
