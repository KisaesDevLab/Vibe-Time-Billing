// Authored preview — @vibe/ui Markdown
import { Markdown, Card, tokens } from '@vibe/ui';

const frame = {
  background: tokens.color.bg,
  padding: 20,
  fontFamily: tokens.font.body,
};

const article = `# Engagement letter — what's included

Your **1120-S** engagement covers preparation of the federal and one state
return for the *2025* tax year. Bookkeeping cleanup is billed separately.

## What we need from you

1. Year-end trial balance exported from QuickBooks
2. Bank and credit-card statements for December
3. Signed [authorization form](https://portal.firm.com/auth) before fieldwork

> Hour-bank residuals are forfeit on close — unused prepaid hours are not
> refunded or carried forward.

You can reference your engagement code \`1120-S-2025\` on any uploaded file.`;

export function KbArticle(): JSX.Element {
  return (
    <div style={frame}>
      <Card style={{ maxWidth: 560, color: tokens.color.text }}>
        <Markdown source={article} />
      </Card>
    </div>
  );
}

const codeNote = `### Adjustment formula

Realization is computed at the per-timekeeper grain:

\`\`\`
realized = sum(allocation.amount) / sum(entry.standard_value)
\`\`\`

- **Write-up** raises billed value above standard
- **Write-down** lowers it; both attribute to the *originating* timekeeper

See the [allocation guide](https://portal.firm.com/kb/allocation) for the six
supported methods.`;

export function CodeAndLists(): JSX.Element {
  return (
    <div style={frame}>
      <Card style={{ maxWidth: 560, color: tokens.color.text }}>
        <Markdown source={codeNote} />
      </Card>
    </div>
  );
}
