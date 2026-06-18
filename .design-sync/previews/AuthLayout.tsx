// Authored preview — @vibe/ui AuthLayout
// NOTE: AuthLayout mounts useLightAuthTheme(), which forces data-theme="light"
// on <html> when no saved theme exists. In the preview frame the card may
// therefore render against light tokens rather than the DS dark default.
import { AuthLayout, Button, Input, tokens } from '@vibe/ui';

const frame = {
  fontFamily: tokens.font.body,
  minHeight: 520,
};

export function SignIn(): JSX.Element {
  return (
    <div style={frame}>
      <AuthLayout
        brand="Vibe Time & Billing"
        title="Sign in"
        subtitle="Staff access for Kisaes & Co. CPAs"
        footer={<span>Trouble signing in? Contact your firm administrator.</span>}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Input label="Work email" type="email" placeholder="you@kisaescpa.com" />
          <Input label="Password" type="password" placeholder="••••••••" />
          <Button>Continue</Button>
          <Button variant="ghost" size="sm">
            Email me a magic link instead
          </Button>
        </div>
      </AuthLayout>
    </div>
  );
}

export function PortalOtp(): JSX.Element {
  return (
    <div style={frame}>
      <AuthLayout
        brand="Client Portal"
        title="Verify your phone"
        subtitle="We sent a 6-digit code to (•••) •••-4821"
        footer={<span>Didn't get it? Resend in 0:42</span>}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Input label="Verification code" placeholder="123456" inputMode="numeric" />
          <Button>Verify &amp; continue</Button>
        </div>
      </AuthLayout>
    </div>
  );
}
