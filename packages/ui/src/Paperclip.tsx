// SPDX-License-Identifier: Elastic-2.0
//
// Clean line-art paperclip icon (not the emoji). Used by the message
// composers to attach files. Size + color are props.

export interface PaperclipProps {
  size?: number;
  color?: string;
  title?: string;
}

export function Paperclip({
  size = 22,
  color = 'currentColor',
  title,
}: PaperclipProps): JSX.Element {
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
      aria-label={title ?? 'Attach'}
    >
      {title ? <title>{title}</title> : null}
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
