// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Line-art icon set (Feather-style, 24x24, stroke=currentColor). Same
// convention as Paperclip.tsx: size + color props, optional title that
// becomes an accessible <title> + aria-label. Used by icon-only action
// buttons (the client Files tab toolbar/rows, folder tree, etc.).

export interface IconProps {
  size?: number;
  color?: string;
  title?: string;
}

function Svg({
  size = 18,
  color = 'currentColor',
  title,
  children,
}: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Envelope — send / resend by email. */
export function MailIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </Svg>
  );
}

/** Speech bubble — send / resend by text message. */
export function MessageIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
    </Svg>
  );
}

/** Closed padlock — "private" visibility. */
export function Lock(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  );
}

/** Eye — "client visible". */
export function Eye(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** Share — node graph. */
export function ShareIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </Svg>
  );
}

/** Flag — used for "flag as tax return". */
export function Flag(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </Svg>
  );
}

/** Download — tray + down arrow. */
export function Download(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  );
}

/** Magnifier — "preview". */
export function Search(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Svg>
  );
}

/** Chevron pointing right — collapsed tree node. */
export function ChevronRight(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="9 18 15 12 9 6" />
    </Svg>
  );
}

/** Chevron pointing down — expanded tree node. */
export function ChevronDown(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

/** Printer. */
export function Printer(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </Svg>
  );
}

/** Trash can — destructive delete actions. */
export function Trash(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </Svg>
  );
}

/** Folder. */
export function Folder(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

/** Hamburger — opens the phone nav drawer (AppShell mobile app bar). */
export function MenuIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </Svg>
  );
}

/** X — close affordance for sheets / the phone drawer. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  );
}
