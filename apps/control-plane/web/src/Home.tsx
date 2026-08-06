import React from "react";
import { SiteBar, SiteFoot } from "./Chrome.js";
import "./notary.css";

const METRICS = [
  { value: "14.0s", label: "Fast queue turn to confirmed merge", source: "9 merges · recallnet/thwip" },
  { value: "28.0s", label: "Fresh assignment to signed merge record", source: "7 merges · recallnet/thwip-test" },
  { value: "73s", label: "Cloud candidate-verification wall clock", source: "18 jobs · recallnet/thwip" },
] as const;

const PROFILES = [
  {
    name: "Fast",
    body: "Fast reuses the proof the pull request already carries. The queue moves the branch without starting a cloud run.",
  },
  {
    name: "Fresh",
    body: "Fresh pins the integration candidate. A device claims the turn, runs that candidate, and returns a signed receipt.",
  },
  {
    name: "Remote",
    body: "Remote runs the required suites in GitHub Actions for repositories that require a cloud result.",
  },
  {
    name: "Audited",
    body: "Audited requires the device receipt and the GitHub result before the merge moves the branch.",
  },
] as const;

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

function QueueDiagram() {
  return (
    <figure className="mq-diagram" aria-label="Three agent checkouts feed a protected merge queue">
      <div className="mq-diagram__agents">
        {["agent 01", "agent 02", "agent 03"].map((agent, index) => (
          <div className="mq-agent" key={agent}>
            <span className="mq-agent__id">{agent}</span>
            <span className="mq-agent__branch">branch checked</span>
            <span className="mq-agent__proof">proof attached</span>
            <span className="mq-agent__line" aria-hidden="true" />
            <span className="mq-agent__number">{String(index + 1).padStart(2, "0")}</span>
          </div>
        ))}
      </div>
      <div className="mq-lane">
        <span className="mq-lane__label">Thwip Queue</span>
        <span className="mq-lane__detail">one protected merge lane</span>
        <span className="mq-lane__arrow" aria-hidden="true">→</span>
        <span className="mq-lane__main">main</span>
      </div>
      <figcaption>
        Agents run CI in parallel. The queue carries their proof through the merge point.
      </figcaption>
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
          <section className="mq-hero">
            <p className="mq-kicker">Merge queue for AI-native teams</p>
            <h1>
              <span className="mq-hero__line">Your agents ran CI.</span>
              <span className="mq-hero__line">Your merge queue</span>
              <span className="mq-hero__line">should use it.</span>
            </h1>
            <p className="mq-hero__lede">
              Each coding agent tests its branch before its pull request joins the line. Thwip carries that work into
              a protected merge lane, so completed runs move <code>main</code> instead of becoming a cloud CI queue.
            </p>
            <div className="nt-actions mq-hero__actions">
              <SetupAction me={me} signIn={signIn} />
              <a className="nt-btn nt-btn--ghost" href="/blog/merge-queue/">
                Read the queue research
              </a>
            </div>
          </section>

          <section className="mq-measures" aria-label="Queue operating measurements">
            {METRICS.map((metric) => (
              <article className="mq-measure" key={metric.label}>
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
                <small>{metric.source}</small>
              </article>
            ))}
          </section>

          <section className="nt-field mq-field">
            <div className="nt-label">
              The work<b>Already ran</b>
            </div>
            <div className="nt-body">
              <h2>Agent work arrives in parallel. Cloud queues put it back in series.</h2>
              <p>
                Your agents finish branches at the same time. Each pull request reaches the merge lane with a passing
                run behind it. A cloud queue creates an integrated candidate and starts another CI job for each turn.
              </p>
              <p>
                Thwip keeps the proof with the commit. Fast uses it at the merge point. Fresh uses the same agent
                capacity to verify the pinned candidate when the pull request reaches the front of the line.
              </p>
              <QueueDiagram />
            </div>
          </section>

          <section className="nt-field mq-field">
            <div className="nt-label">
              The lane<b>Moves on evidence</b>
            </div>
            <div className="nt-body">
              <h2>Turn agent-run CI into merge capacity.</h2>
              <p>
                Thwip gives one pull request a turn, pins its base, head, candidate commit, and candidate tree, then
                asks for the evidence that policy requires. The GitHub App writes the merge on the protected branch.
              </p>
              <div className="mq-profiles">
                {PROFILES.map((profile) => (
                  <article className="mq-profile" key={profile.name}>
                    <h3>{profile.name}</h3>
                    <p>{profile.body}</p>
                  </article>
                ))}
              </div>
              <p className="nt-note">
                Pick an organization default in the dashboard. Use <code>thwip.yaml</code> when one repository needs
                a different merge policy.
              </p>
            </div>
          </section>

          <section className="nt-field mq-field">
            <div className="nt-label">
              The branch<b>Stays controlled</b>
            </div>
            <div className="nt-body">
              <h2>One writer for <code>main</code>. One answer for every pull request.</h2>
              <p>
                The queue rejects a candidate when its base moved, required evidence does not match policy, or a
                required suite failed. Each pull request gets a position, a state, and a reason. Your agents read the
                same queue state through one authenticated API call.
              </p>
              <div className="mq-ledger" role="list">
                <div role="listitem">
                  <span>Branch writer</span>
                  <strong>Thwip GitHub App</strong>
                </div>
                <div role="listitem">
                  <span>Protected merge shape</span>
                  <strong>Pinned base and candidate tree</strong>
                </div>
                <div role="listitem">
                  <span>Pull-request status</span>
                  <strong>Position, state, and reason</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="nt-field mq-field">
            <div className="nt-label">
              The record<b>Stays with the merge</b>
            </div>
            <div className="nt-body">
              <h2>The proof sits behind the merge.</h2>
              <p>
                The queue signs a record for each merge. Fast records the reused proof. Fresh records the candidate
                receipt. Remote records the verifier result. You can fetch those signed bytes and verify the branch
                chain without a Thwip account.
              </p>
              <div className="nt-actions">
                <a className="nt-btn nt-btn--ghost" href="/faq">
                  Read the trust model
                </a>
                <a className="nt-btn nt-btn--ghost" href="/blog/beta/">
                  Read the research
                </a>
              </div>
            </div>
          </section>

          <section className="mq-setup">
            <p className="mq-kicker">Repository setup</p>
            <h2>Put Thwip in front of your protected branch.</h2>
            <p>
              Start in the dashboard. Thwip opens the setup pull request, your team observes the queue on live pull
              requests, and a repository administrator enables the App as the branch writer.
            </p>
            <div className="nt-actions">
              <SetupAction me={me} signIn={signIn} />
              <a className="nt-btn nt-btn--ghost" href="/install">
                Set up an agent machine
              </a>
            </div>
          </section>
        </main>

        <SiteFoot />
      </div>
    </div>
  );
}
