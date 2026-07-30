import React, { useEffect, useRef, useState } from "react";
import { SiteBar, SiteFoot } from "./Chrome.js";
import "./notary.css";

/**
 * Every value on this page is taken from one real record: commit cb0fe50 in
 * this repository, its decoded thwip-proof trailer, and the check runs GitHub
 * reports for that commit. The verification sequence mirrors the twelve steps
 * in @thwip/verifier, with the reason codes it actually returns. Nothing here
 * is illustrative, and nothing describes behaviour that is not implemented.
 */

const RECORD = {
  capturedAt: "2026-07-29",
  commit: "cb0fe50",
  tree: "71032873f3e27b80eea468445dfe653875c544c8",
  baseSha: "f3dbaf1ae01840df881b5aaec43def092e6e4ce9",
  policyDigest: "sha256:317753137073f185d383fadf07904f4d8d760de3e8769f6dc6b0a8e7826db7a3",
  policyVersion: 4,
  pipelineDigest: "sha256:b87e9754d2239b0496f98295c453a34973f795be4c20261c48ec77270ae545e9",
  runner: "command",
  evaluationMode: "head-tree",
  keyId: "SHA256:nXERD2khQGOHccKTXtLUpsivMtnR2X1BSV6mLOeKfV4",
  githubUserId: "264261678",
  trailer:
    "thwip-proof: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlMQ0p6ZFdKcVpXTjBJanBiZXlKdVlXMWxJam9pWjJsMExYUnlaV1VpTENKa2FXZGxjM1FpT25zaWMyaGhNU0k2SWpjeE1ETXlPRGN6",
  trailerBytes: 2622,
  suites: [
    { id: "lint", status: "passed", ms: 205 },
    { id: "typecheck", status: "passed", ms: 1916 },
    { id: "test", status: "passed", ms: 693 },
  ],
  totalMs: 2815,
  checkSeconds: 14,
} as const;

type Step = { kind: "cmd" } | { kind: "suite"; i: number } | { kind: "sign" } | { kind: "trailer" };

const STEPS: Step[] = [
  { kind: "cmd" },
  { kind: "suite", i: 0 },
  { kind: "suite", i: 1 },
  { kind: "suite", i: 2 },
  { kind: "sign" },
  { kind: "trailer" },
];

/** Wall-clock offset at which each line appeared, from the record's own timings. */
function stepTimes(): number[] {
  const t = [0];
  let acc = 0;
  for (const s of RECORD.suites) {
    acc += s.ms;
    t.push(acc);
  }
  t.push(acc + 60);
  t.push(acc + 120);
  return t;
}

function useReplay() {
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [visible, setVisible] = useState(reduced ? STEPS.length : 0);
  const [clock, setClock] = useState(reduced ? RECORD.totalMs : 0);
  const raf = useRef(0);

  useEffect(() => {
    if (reduced) return;
    const times = stepTimes();
    const start = performance.now();
    const tick = (now: number) => {
      const t = now - start;
      setClock(Math.min(t, RECORD.totalMs));
      let n = 0;
      while (n < times.length && times[n]! <= t) n += 1;
      setVisible(n);
      if (n < STEPS.length) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [reduced]);

  return { visible, clock, done: visible >= STEPS.length };
}

function Record() {
  const { visible, clock, done } = useReplay();

  return (
    <figure className="nt-record">
      <div className="nt-record__head">
        <span>Record of a run</span>
        <span>
          {RECORD.capturedAt} · commit {RECORD.commit}
        </span>
      </div>
      <div className="nt-record__lines">
        {STEPS.slice(0, visible).map((s, idx) => {
          if (s.kind === "cmd") {
            return (
              <div className="nt-line nt-line--cmd" key={idx}>
                <span>$</span>
                <em>thwip run</em>
              </div>
            );
          }
          if (s.kind === "suite") {
            const suite = RECORD.suites[s.i]!;
            return (
              <div className="nt-line" key={idx}>
                <span className="nt-line__id">{suite.id}</span>
                <span className="nt-dot" />
                <span className="nt-line__st">{suite.status}</span>
                <span className="nt-line__ms">{suite.ms} ms</span>
              </div>
            );
          }
          if (s.kind === "sign") {
            return (
              <div className="nt-line nt-line--cmd" key={idx}>
                <span className="nt-line__id">signed</span>
                <span>
                  tree <b>{RECORD.tree.slice(0, 12)}</b> · {RECORD.keyId.slice(0, 21)}…
                </span>
              </div>
            );
          }
          return (
            <div className="nt-line nt-line--cmd" key={idx}>
              <span className="nt-line__id">trailer</span>
              <span>
                {RECORD.trailerBytes} bytes on HEAD
                {!done && <span className="nt-caret" />}
              </span>
            </div>
          );
        })}
      </div>
      <figcaption className="nt-record__foot">
        <span>
          Replay of a captured run · suites took{" "}
          <span className="nt-clock">{(clock / 1000).toFixed(3)}s</span>
        </span>
        <span className={done ? "nt-stamp nt-stamp--on" : "nt-stamp"} aria-hidden={!done}>
          <b>Pass</b>
          {RECORD.capturedAt}
        </span>
      </figcaption>
    </figure>
  );
}

/** The twelve checks in @thwip/verifier, in the order it runs them. */
const SEQUENCE: Array<{ step: string; asks: string; codes: string[] }> = [
  {
    step: "Carrier",
    asks: "Does the head commit carry exactly one trailer of a sane size, shaped like a DSSE envelope?",
    codes: ["PROOF_MISSING", "PROOF_DUPLICATE", "PROOF_TOO_LARGE", "PROOF_MALFORMED"],
  },
  {
    step: "Signature",
    asks: "Does the SSH signature verify over the exact payload bytes, before any of it is parsed?",
    codes: ["SIGNER_KEY_UNKNOWN", "SIGNER_KEY_REVOKED", "SIGNER_KEY_ALGORITHM_FORBIDDEN", "SIGNATURE_INVALID"],
  },
  {
    step: "Statement",
    asks: "Does the signed statement parse strictly, at a schema version this verifier knows?",
    codes: ["PROOF_MALFORMED", "PROOF_SCHEMA_UNSUPPORTED"],
  },
  {
    step: "Repository",
    asks: "Do the owner and repository ids match what GitHub reports, rather than what the proof claims?",
    codes: ["SUBJECT_REPOSITORY_MISMATCH"],
  },
  {
    step: "Git subject",
    asks: "Is the signed tree the tree of this head commit, with the recorded ancestry and base?",
    codes: ["SUBJECT_TREE_MISMATCH", "SUBJECT_ANCESTRY_MISMATCH", "SUBJECT_BASE_MISMATCH"],
  },
  {
    step: "Policy",
    asks: "Is the policy the proof names active for this repository, in the same evaluation mode?",
    codes: ["POLICY_NOT_ACTIVE"],
  },
  {
    step: "Pipeline",
    asks: "Do the pipeline digest and runner match that active policy exactly?",
    codes: ["PIPELINE_DIGEST_MISMATCH"],
  },
  {
    step: "Signer",
    asks: "Is the signer the key's owner, holding an active grant of sufficient permission, and permitted to sign their own pull request?",
    codes: ["SIGNER_MISMATCH", "SIGNER_PERMISSION_INSUFFICIENT"],
  },
  {
    step: "Required suites",
    asks: "Is every required suite present exactly once, and did each one pass?",
    codes: ["SUITE_MISSING", "SUITE_DUPLICATE", "SUITE_NOT_PASSED"],
  },
  {
    step: "Remote suites",
    asks: "For suites the policy sends to GitHub, did GitHub's own check on this commit succeed?",
    codes: ["SUITE_MISSING", "SUITE_NOT_PASSED"],
  },
  {
    step: "Age",
    asks: "Did the run finish inside the policy's maximum proof age?",
    codes: ["PROOF_EXPIRED"],
  },
  {
    step: "Lease",
    asks: "If the profile requires a lease, does the run carry one?",
    codes: ["LEASE_REQUIRED"],
  },
];

const PROFILES = [
  {
    name: "Fast",
    body: "No lease. The run records its own network and cache modes, signed.",
    fact: "lease.required = false",
  },
  {
    name: "Fresh",
    body: "A lease, claimed before the run, so it cannot be back-dated.",
    fact: "lease.required = true · 1800s",
  },
  {
    name: "Remote",
    body: "Named suites run on GitHub. The check needs GitHub's own conclusion.",
    fact: "verified from check runs",
  },
];

export function Home({
  me,
  signIn,
}: {
  me: { organization: { github_login: string } | null } | null | undefined;
  signIn: () => void;
}) {
  return (
    <div className="nt">
      <div className="nt-page">
        <SiteBar me={me} signIn={signIn} />

        {/* 1 ─────────────────────────────────────────── */}
        <section className="nt-field">
          <div className="nt-label">
            Field 1<b>What this is</b>
          </div>
          <div className="nt-body">
            <div className="nt-figures">
              <div className="nt-fig">
                <span className="nt-fig__n">
                  2.8<small>s</small>
                </span>
                <span className="nt-fig__l">Suites, start to finish, on the developer's machine</span>
              </div>
              <div className="nt-fig">
                <span className="nt-fig__n">
                  {RECORD.checkSeconds}
                  <small>s</small>
                </span>
                <span className="nt-fig__l">For the check to report on GitHub, runner startup included</span>
              </div>
              <div className="nt-fig">
                <span className="nt-fig__n">0</span>
                <span className="nt-fig__l">Suites re-run in the cloud for this commit</span>
              </div>
            </div>
            <p className="nt-lede">
              CI runs where the code lives. thwip signs a proof of the exact Git tree, carries it on the commit,
              and a protected check verifies that proof instead of running your tests again.
            </p>
            <Record />
            <div className="nt-actions">
              <a className="nt-btn" href="/install">
                Set up a repository
              </a>
              <a className="nt-btn nt-btn--ghost" href="/faq">
                Read the trust model
              </a>
            </div>
            <p className="nt-note">
              Both figures come from the record below, on commit {RECORD.commit} of this control plane.
            </p>
          </div>
        </section>

        {/* 2 ─────────────────────────────────────────── */}
        <section className="nt-field">
          <div className="nt-label">
            Field 2<b>What got signed</b>
          </div>
          <div className="nt-body">
            <h2>The proof commits to the tree, not to a claim about the tree.</h2>
            <dl className="nt-pairs">
              <div className="nt-pair">
                <dt>Subject</dt>
                <dd>git-tree {RECORD.tree}</dd>
              </div>
              <div className="nt-pair">
                <dt>Predicate type</dt>
                <dd>urn:thwip:attestation:ci-run:v1</dd>
              </div>
              <div className="nt-pair">
                <dt>Evaluation mode</dt>
                <dd>{RECORD.evaluationMode}</dd>
              </div>
              <div className="nt-pair">
                <dt>Base</dt>
                <dd>origin/main {RECORD.baseSha.slice(0, 12)}</dd>
              </div>
              <div className="nt-pair">
                <dt>Policy</dt>
                <dd>
                  version {RECORD.policyVersion} · {RECORD.policyDigest}
                </dd>
              </div>
              <div className="nt-pair">
                <dt>Pipeline</dt>
                <dd>
                  {RECORD.runner} · {RECORD.pipelineDigest}
                </dd>
              </div>
              <div className="nt-pair">
                <dt>Signer key</dt>
                <dd>{RECORD.keyId}</dd>
              </div>
              <div className="nt-pair">
                <dt>GitHub user id</dt>
                <dd>{RECORD.githubUserId}</dd>
              </div>
            </dl>
            <p className="nt-note">{RECORD.trailerBytes} bytes, carried as a Git trailer:</p>
            <pre className="nt-raw">{RECORD.trailer}…</pre>
            <p>
              A DSSE envelope over an in-toto Statement, signed with an SSH key. GitHub owns the binding from key
              to person, so thwip keeps no identity system of its own.
            </p>
          </div>
        </section>

        {/* 3 ─────────────────────────────────────────── */}
        <section className="nt-field">
          <div className="nt-label">
            Field 3<b>How the check decides</b>
          </div>
          <div className="nt-body">
            <p>
              Twelve checks, in this order, against the head commit. A failure names the step, not a log to go
              read.
            </p>
            <div className="nt-scroll">
            <table className="nt-table">
              <thead>
                <tr>
                  <th className="nt-th-n" />
                  <th className="nt-th-s">Step</th>
                  <th>What it asks</th>
                  <th className="nt-th-c">Reason codes</th>
                </tr>
              </thead>
              <tbody>
                {SEQUENCE.map((row, i) => (
                  <tr key={row.step}>
                    <td className="n m">{String(i + 1).padStart(2, "0")}</td>
                    <td>{row.step}</td>
                    <td>{row.asks}</td>
                    <td>
                      {row.codes.map((c) => (
                        <code className="nt-code-fail" key={c}>
                          {c}
                        </code>
                      ))}
                    </td>
                  </tr>
                ))}
                <tr className="is-pass">
                  <td className="n m">✓</td>
                  <td>Verdict</td>
                  <td>All twelve, on this commit, with no step skipped.</td>
                  <td>
                    <code className="nt-code-pass">PASS</code>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <p className="nt-note">
              The verifier is a pure function, so <code>thwip verify</code> gives you the answer the check will
              give.
            </p>
          </div>
        </section>

        {/* 4 ─────────────────────────────────────────── */}
        <section className="nt-field">
          <div className="nt-label">
            Field 4<b>Where the work runs</b>
          </div>
          <div className="nt-body">
            <h2>Choose, per suite, who has to have done the work.</h2>
            <p>
              A proof is a named person's signed assertion. When a suite needs a third party to have run it
              instead, send that one to GitHub. <a href="/faq">What a proof establishes</a>.
            </p>
            <div className="nt-cols">
              {PROFILES.map((p) => (
                <div className="nt-col" key={p.name}>
                  <h3>{p.name}</h3>
                  <p>{p.body}</p>
                  <span className="slsa">{p.fact}</span>
                </div>
              ))}
            </div>
            <p className="nt-note">
              A macOS or Windows build belongs under <code>remote:</code>.
            </p>
          </div>
        </section>

        {/* 5 ─────────────────────────────────────────── */}
        <section className="nt-field">
          <div className="nt-label">
            Field 5<b>How it fits your repository</b>
          </div>
          <div className="nt-body">
            <p>One committed file. This is the whole configuration of the repository above:</p>
            <pre className="nt-raw nt-raw--code">{`version: 4
profile: fast
required:
  - lint
  - typecheck
  - test`}</pre>
            <p>
              Suite ids name package.json scripts, or <code>pipeline.module</code> points at a Dagger module and
              matrices live there. The CLI provisions its own Dagger engine, so adopting thwip is not adopting
              another global toolchain.
            </p>
            <div className="nt-cmd">
              <span>$</span> thwip init --required &quot;lint,typecheck,test&quot;
            </div>
            <div className="nt-cmd">
              <span>$</span> thwip run
            </div>
            <p className="nt-note">
              Setup is a prompt for your coding agent, at <a href="/install">/install</a>.
            </p>
          </div>
        </section>

        {/* 6 ─────────────────────────────────────────── */}
        <section className="nt-field">
          <div className="nt-label">
            Field 6<b>Price</b>
          </div>
          <div className="nt-body">
            <h2>Both plans verify identically. The plan sets the limits.</h2>
            <div className="nt-scroll">
            <table className="nt-table">
              <thead>
                <tr>
                  <th className="nt-th-s">Plan</th>
                  <th className="nt-th-s">Price</th>
                  <th className="nt-th-s">Enabled projects</th>
                  <th>Signers</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Free</td>
                  <td className="n">$0</td>
                  <td className="n">3</td>
                  <td className="n">5</td>
                </tr>
                <tr>
                  <td>Pro</td>
                  <td className="n">$5 / month</td>
                  <td className="n">15</td>
                  <td className="n">25</td>
                </tr>
              </tbody>
            </table>
            </div>
            <div className="nt-actions">
              <a className="nt-btn" href="/install">
                Set up a repository
              </a>
              {!me && (
                <button className="nt-btn nt-btn--ghost" onClick={signIn}>
                  Sign in with GitHub
                </button>
              )}
            </div>
          </div>
        </section>

        <SiteFoot />
      </div>
    </div>
  );
}
