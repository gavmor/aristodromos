// Tailwind class sets shared by the popup, the panel and the config form, so a
// button or a field looks the same wherever it is drawn.

export const button =
  'inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-0.5 text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

export const primaryButton = `${button} border-primary text-primary`;

export const field =
  'w-full min-w-0 rounded-md border border-input bg-background px-1.5 py-0.5 text-foreground outline-none invalid:border-destructive focus-visible:ring-1 focus-visible:ring-ring';

/** A label stacked over its control, sharing a row with its siblings. */
export const labelled = 'mt-1.5 flex min-w-0 flex-1 flex-col gap-0.5';

/** A checkbox and its text on one line. */
export const inline = 'flex items-center gap-1';

export const heading = 'text-xs font-normal uppercase tracking-wide text-muted-foreground';

export const section = 'border-b border-border py-2.5';

/** The page header: title, run state, controls. */
export const header = 'flex items-center gap-2 border-b border-border pb-2';

export const title = 'text-sm font-semibold';
