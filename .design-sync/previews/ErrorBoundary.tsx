// Authored preview — @vibe/ui ErrorBoundary
import { ErrorBoundary, Card, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

// ErrorBoundary renders its fallback ONLY after a child throws during render.
// In a static preview no child throws, so it transparently renders children —
// this cell shows that happy-path pass-through wrapping a normal page section.
export function HappyPath(): JSX.Element {
  return (
    <div style={frame}>
      <ErrorBoundary label="engagement-page">
        <Card title="Engagement: Audit — Riverside Credit Union" style={{ maxWidth: 480 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: tokens.color.text }}>
            The boundary wraps this section. When nothing throws it is invisible and simply passes
            its children through. If a descendant throws during render, it swaps to a centered
            “Something went wrong” fallback with Reload / Go home actions instead of unmounting the
            whole SPA to a blank screen.
          </p>
        </Card>
      </ErrorBoundary>
    </div>
  );
}
