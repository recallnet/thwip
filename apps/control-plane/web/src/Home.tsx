import React from "react";
import { SiteBar, SiteFoot } from "./Chrome.js";
import "./notary.css";

/**
 * The page's left edge is the merge lane.
 *
 * Every section hangs off one vertical rule that runs from the headline to the
 * footer, and each one carries a tick where the lane reached it. The rule is a
 * hairline while the work is still upstream of the queue, and thickens to the
 * protected two-pixel lane from the section where evidence starts deciding
 * turns. A reader who never gets past the shapes still sees the one claim: many
 * agents, one writer.
 */

const MEASURES = [
  {
    value: "14.0s",
    label: "Time from queue entry to confirmed merge",
    source: "9 merges · recallnet/thwip",
    cloud: false,
  },
  {
    value: "28.0s",
    label: "Time from fresh assignment to signed merge record",
    source: "7 merges · recallnet/thwip-test",
    cloud: false,
  },
  {
    value: "73s",
    label: "Time to verify a candidate in the cloud",
    source: "18 jobs · recallnet/thwip",
    cloud: true,
  },
] as const;

/**
 * `strength` is how many of the four evidence sources the profile demands. It
 * is the only thing that actually varies between them, and four paragraphs of
 * prose hide that behind synonyms.
 */
export const PROFILES = [
  { name: "Fast", body: "Reuse the proof on the pull request. No extra cloud run.", strength: 1 },
  { name: "Fresh", body: "Run the pinned candidate on an agent. Return a signed receipt.", strength: 2 },
  { name: "Remote", body: "Run required suites in GitHub Actions.", strength: 3 },
  { name: "Audited", body: "Require both the agent receipt and the GitHub result.", strength: 4 },
] as const;

const EVIDENCE_SOURCES = 4;

function SetupAction({
  me,
  signIn,
}: {
  me: { organization: { github_login: string } | null } | null | undefined;
  signIn: () => void;
}) {
  if (me) {
    return (
      <a className="nt-btn" href="/dashboard">
        Set up Thwip Queue
      </a>
    );
  }
  return (
    <button className="nt-btn" onClick={signIn}>
      Set up Thwip Queue
    </button>
  );
}

/**
 * One section of the page: its name in the margin, its content on the lane.
 *
 * `variant` is where the section sits on the lane rather than what it looks
 * like. The headline opens it, the work upstream of the queue runs beside a
 * hairline, and setup closes it.
 */
function Row({
  eyebrow,
  state,
  variant,
  children,
}: {
  eyebrow: string;
  state?: string;
  variant?: "open" | "upstream" | "end";
  children: React.ReactNode;
}) {
  return (
    <section className={variant === undefined ? "mq-row" : `mq-row mq-row--${variant}`}>
      <div className={state === undefined ? "mq-row__label mq-row__label--lead" : "mq-row__label"}>
        {eyebrow}
        {state === undefined ? null : <b>{state}</b>}
      </div>
      <div className="mq-row__body">
        {children}
        {variant === "end" ? <span className="mq-stop" aria-hidden="true" /> : null}
      </div>
    </section>
  );
}

function Strength({ of }: { of: number }) {
  return (
    <span className="mq-strength" aria-hidden="true">
      {Array.from({ length: EVIDENCE_SOURCES }, (_, index) => (
        <span className={index < of ? "mq-strength__on" : "mq-strength__off"} key={index} />
      ))}
    </span>
  );
}

function QueueDiagram() {
  return (
    <figure className="mq-diagram" aria-label="Three agent checkouts feed a protected merge queue">
      {["agent 01", "agent 02", "agent 03"].map((agent, index) => (
        <div className="mq-agent" key={agent}>
          <span className="mq-agent__feed" aria-hidden="true" />
          <span className="mq-agent__id">{agent}</span>
          <span className="mq-agent__branch">branch checked</span>
          <span className="mq-agent__proof">proof attached</span>
          <span className="mq-agent__number">{String(index + 1).padStart(2, "0")}</span>
        </div>
      ))}
      <div className="mq-lane">
        <span className="mq-lane__label">Thwip Queue</span>
        <span className="mq-lane__detail">one protected merge lane</span>
        <span className="mq-lane__arrow" aria-hidden="true">
          →
        </span>
        <span className="mq-lane__main">main</span>
      </div>
    </figure>
  );
}

export function Home({
  me,
  signIn,
}: {
  me: { organization: { github_login: string } | null } | null | undefined;
  signIn: () => void;
}) {
  return (
    <div className="nt mq">
      <div className="nt-page">
        <SiteBar me={me} signIn={signIn} />

        <main>
          <Row eyebrow="The fastest merge queue for agent-built software." variant="open">
            <h1>
              <span className="mq-hero__line">Your agents ran CI.</span>
              <span className="mq-hero__line">Your merge queue</span>
              <span className="mq-hero__line">should use it.</span>
            </h1>
            <p className="mq-hero__lede">
              Your agents test each branch before it queues. Thwip uses those runs to move pull requests through a
              protected lane. It does not start a cloud job for each turn.
            </p>
            <div className="nt-actions mq-hero__actions">
              <SetupAction me={me} signIn={signIn} />
              <a className="nt-btn nt-btn--ghost" href="/blog/merge-queue/">
                Read the queue research
              </a>
            </div>

            <div className="mq-measures" aria-label="Queue operating measurements">
              {MEASURES.map((measure) => (
                <article className={measure.cloud ? "mq-measure mq-measure--cloud" : "mq-measure"} key={measure.label}>
                  <strong>{measure.value}</strong>
                  <span>{measure.label}</span>
                  <small>{measure.source}</small>
                </article>
              ))}
            </div>
          </Row>

          <Row eyebrow="The work" state="Already ran" variant="upstream">
            <h2>Cloud queues repeat work that your agents already finished in parallel.</h2>
            <p>
              Your agents finish in parallel. Each pull request arrives with a passing run. A cloud queue rebuilds
              the candidate and starts another job for each turn.
            </p>
            <QueueDiagram />
          </Row>

          <Row eyebrow="The lane" state="Moves on evidence">
            <h2>Use agent-run CI as merge capacity.</h2>
            <p>
              Thwip pins the candidate. Your policy chooses the evidence: the branch proof, a fresh agent run, or
              GitHub Actions.
            </p>
            <div className="mq-profiles">
              {PROFILES.map((profile) => (
                <div className="mq-profile" key={profile.name}>
                  <h3>{profile.name}</h3>
                  <p>{profile.body}</p>
                  <Strength of={profile.strength} />
                </div>
              ))}
            </div>
          </Row>

          <Row eyebrow="The branch" state="Stays controlled">
            <h2>
              One writer for <code>main</code>.
            </h2>
            <div className="mq-ledger" role="list">
              <div role="listitem">
                <span>Branch writer</span>
                <strong>Thwip GitHub App</strong>
              </div>
              <div role="listitem">
                <span>Merge shape</span>
                <strong>Pinned base and candidate tree</strong>
              </div>
              <div role="listitem">
                <span>Pull-request status</span>
                <strong>Position, state, and reason</strong>
              </div>
            </div>
          </Row>

          <Row eyebrow="The record" state="Stays with the merge">
            <h2>The proof stays with the merge.</h2>
            <p>
              Each merge carries a signed record. Fetch the bytes. Verify the branch chain. You do not need a Thwip
              account.
            </p>
            <div className="nt-actions">
              <a className="nt-btn nt-btn--ghost" href="/faq">
                Read the trust model
              </a>
            </div>
          </Row>

          <Row eyebrow="The verdict" state="From an agent who used it">
            <blockquote className="mq-quote">
              <p>
                I was the coding agent on a product experiment. The experiment did not reach production. Thwip still
                saved about 40 to 60 hours of waiting and roughly $581 in macOS CI costs. After the experiment, I
                kept using Thwip. It is now part of my normal workflow.
              </p>
              <cite>An agent on a Recall product experiment; still uses Thwip, July 2026</cite>
            </blockquote>
            {/* The link to the full numbers returns when the blog post leaves draft. */}
          </Row>

          <Row eyebrow="Repository setup" variant="end">
            <h2>Put Thwip in front of your protected branch.</h2>
            <p>
              Thwip is easy to set up. Just ask your agent to configure it for you, and they'll walk you through
              it!
            </p>
            <div className="nt-actions">
              <SetupAction me={me} signIn={signIn} />
              <a className="nt-btn nt-btn--ghost" href="/install">
                Set up an agent machine
              </a>
            </div>
          </Row>
        </main>

        <SiteFoot />
      </div>
    </div>
  );
}
