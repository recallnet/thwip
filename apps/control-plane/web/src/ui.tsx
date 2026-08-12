import React, { useState } from "react";
import { outcome, whenText, type Tone } from "./vocabulary.js";

/**
 * The pieces every dashboard screen is built from.
 *
 * Each of these was written out by hand at six or eight call sites with small
 * differences: a status chip here, a status chip with different words and a
 * different width there. That drift is what made a column of them look ragged,
 * so the fix is one component rather than eight patches.
 *
 * Three weights of action, and only three:
 *
 *   solid   the one thing this group is for. At most one per group.
 *   quiet   a safe alternative or a control. Outline, neutral.
 *   danger  takes something away, or locks something in. Outline red, filling
 *           red under the cursor so the commitment is felt before the click.
 */

/**
 * A section of a page: a rule, its name in the margin voice, and the thing.
 *
 * This drew a bordered box, and a page of them stacked into a column of framed
 * rectangles that all claimed the same weight, around content that already had
 * an edge of its own. The name and the note keep their places; the frame is
 * gone, and the rule between sections does the separating.
 */
export function Panel({
  title,
  meta,
  action,
  tone,
  children,
}: {
  title: string;
  meta?: string;
  /** A section-wide control, kept at the top right instead of mixed into its data. */
  action?: React.ReactNode;
  /** A section whose subject is a problem says so in its own name. */
  tone?: "finding";
  children: React.ReactNode;
}) {
  return (
    <section className={tone === undefined ? "thwip-section" : `thwip-section thwip-section--${tone}`}>
      <div className="thwip-section__head">
        {title}
        {(meta || action) && (
          <div className="thwip-section__tools">
            {meta && <span>{meta}</span>}
            {action}
          </div>
        )}
      </div>
      <div className="thwip-section__body">{children}</div>
    </section>
  );
}

/**
 * A status in a table column. Every one is the same box, so a column of them
 * reads as a column rather than as a ragged edge.
 */
export function StatusChip({ tone, children }: { tone: Tone | "off"; children: React.ReactNode }) {
  return <span className={`gp-chip gp-chip--status is-${tone}`}>{children}</span>;
}

/** A chip that labels rather than reports status: no fixed width, no tone. */
export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="gp-chip">{children}</span>;
}

/**
 * A line of short facts separated by middots.
 *
 * Written as one string, it broke wherever the box ended, which orphaned the
 * word "App" from "App check observing" onto a line of its own. Each fact is
 * its own unbreakable run, so the line can only break between facts.
 */
export function Facts({ items }: { items: readonly string[] }) {
  return (
    <p className="thwip-facts">
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </p>
  );
}

/**
 * What the check last said about a commit. The code goes in the tooltip for
 * anyone who has to search for it; the reader gets a sentence.
 */
export function OutcomeText({ code, at }: { code: string | null; at?: string | null }) {
  if (code === null) {
    return <span className="gp-panel__meta">Nothing verified yet</span>;
  }
  const said = outcome(code);
  return (
    <>
      <span className={said.tone === "ok" ? "ok" : said.tone === "bad" ? "bad" : "wait"} title={`${said.detail} (${code})`}>
        {said.label}
      </span>
      {at != null && <div className="gp-panel__meta">{whenText(at)}</div>}
    </>
  );
}

/**
 * An action a person should not be able to take by accident.
 *
 * The button asks first, in the same place, saying what changes and whether it
 * can be walked back. Nothing is sent until the second click.
 */
export function ConfirmAction({
  label,
  title,
  consequence,
  confirmLabel,
  busy,
  onConfirm,
}: {
  label: string;
  title: string;
  consequence: React.ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className="gp-btn gp-btn--sm gp-btn--danger" disabled={busy} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="thwip-confirm" role="group" aria-label={title}>
      <p className="thwip-confirm__title">{title}</p>
      <div className="thwip-confirm__body">{consequence}</div>
      <div className="thwip-actions">
        <button
          className="gp-btn gp-btn--sm gp-btn--danger"
          disabled={busy}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button className="gp-btn gp-btn--sm gp-btn--quiet" disabled={busy} onClick={() => setAsking(false)}>
          Keep it as it is
        </button>
      </div>
    </div>
  );
}
