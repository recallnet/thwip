import React, { useCallback, useEffect, useState } from "react";

/* ---------- shared API helpers ---------- */

function selectedOrg(): string | null {
  return localStorage.getItem("thwip.org");
}

function withOrg(path: string): string {
  const org = selectedOrg();
  if (!org) return path;
  return path + (path.includes("?") ? "&" : "?") + "org=" + encodeURIComponent(org);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withOrg(path), {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function signInWithGitHub(callbackURL: string): Promise<void> {
  const res = await api<{ url?: string }>("/api/auth/sign-in/social", {
    method: "POST",
    body: JSON.stringify({ provider: "github", callbackURL }),
  });
  if (res.url) window.location.href = res.url;
}

interface OrgSummary {
  organizationId: string;
  githubOrgId: string;
  githubLogin: string;
  githubOrgRole: string | null;
  activated: boolean;
}

interface Me {
  viewer: { githubUserId: string; githubOrgRole: string | null; activated: boolean };
  principal: { github_login: string; avatar_url: string | null; github_org_role: string | null } | null;
  organization: {
    id: string;
    github_login: string;
    plan: string;
    installation_id: string | null;
    better_auth_org_id: string | null;
  } | null;
  organizations: OrgSummary[];
}

function useMe() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api<Me>("/v1/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  return me;
}

function useFetch<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/* ---------- marketing site ---------- */

const TRAILER_SAMPLE =
  "thwip-proof: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5Rdi4uLiJ9";

function Slip() {
  return (
    <figure className="thwip-slip" aria-label="A signed thwip proof carried in a git commit message">
      <span className="thwip-stamp">VERIFIED</span>
      <div className="dim">$ git log -1 --format=%B</div>
      <hr />
      <div>feat: parse lease context into verifier</div>
      <br />
      <div className="trailer">{TRAILER_SAMPLE.slice(0, 118)}…</div>
      <hr />
      <div className="dim"># protected check · repository 1315419165</div>
      <div>
        tree <span className="dim">9223b1ca…</span> suites <span className="pass">lint ✓ typecheck ✓ test ✓</span>
      </div>
      <div>
        signer <span className="dim">key_67f1c7… (ssh-ed25519)</span>
      </div>
      <div>
        verdict <span className="pass">PASS</span>
        <span className="dim"> · 4.1s · nothing rerun</span>
      </div>
    </figure>
  );
}

function SiteNav({ me }: { me: Me | null | undefined }) {
  return (
    <nav className="thwip-nav" aria-label="Site">
      <a className="thwip-brand" href="/">
        thwip<small>VERIFIED LOCAL CI</small>
      </a>
      <span className="links">
        <a href="/#how">How it works</a>
        <a href="/faq">FAQ</a>
        <a href="/install">Install</a>
        <a href="/#pricing">Pricing</a>
        {me ? (
          <a className="gp-btn gp-btn--sm" href="/dashboard">
            Dashboard
          </a>
        ) : (
          <button className="gp-btn gp-btn--sm" onClick={() => void signInWithGitHub("/dashboard")}>
            Sign in with GitHub
          </button>
        )}
      </span>
    </nav>
  );
}

function SiteFooter() {
  return (
    <footer className="thwip-footer">
      <span>thwip · commit-carried CI evidence for agent-run pipelines</span>
      <span>
        <a href="/faq">FAQ</a> · <a href="/install">Install</a> · <a href="/llms.txt">llms.txt</a> ·{" "}
        <code>urn:thwip:attestation:ci-run:v1</code>
      </span>
    </footer>
  );
}

function Marketing({ me }: { me: Me | null | undefined }) {
  return (
    <div className="thwip-shell">
      <SiteNav me={me} />

      <header className="thwip-hero">
        <div>
          <h1>CI ran. Prove it in the commit.</h1>
          <p className="dek">
            Your agents already run lint, typecheck, and tests on the machine where the code lives. thwip signs a
            compact proof of that run, bound to the exact Git tree, and a protected GitHub check verifies it in
            seconds. The merge queue merges on that proof.
          </p>
          <div className="thwip-actions">
            <button className="gp-btn" onClick={() => void signInWithGitHub("/dashboard")}>
              Install on your org
            </button>
            <a className="gp-btn" href="/install">
              Agent install prompt
            </a>
          </div>
          <p className="fine">DSSE · in-toto Statement v1 · OpenSSH signatures · GitHub merge queue native</p>
        </div>
        <Slip />
      </header>

      <section className="thwip-section" id="how">
        <p className="thwip-eyebrow">The loop</p>
        <h2>Your machine runs the checks. GitHub decides the merge.</h2>
        <p className="lede">
          thwip runs no CI itself. The suites run on the machine that already has the warm cache, and the check and
          merge queue stay in GitHub, where your branches already live.
        </p>
        <div className="thwip-steps">
          <div className="thwip-step">
            <div className="k">thwip run</div>
            <h3>Run the approved pipeline locally</h3>
            <p>
              The CLI refuses a dirty tree, runs the policy-approved suites against the frozen source, and signs the
              result. If the tree changes during the run, nothing is signed.
            </p>
          </div>
          <div className="thwip-step">
            <div className="k">thwip-proof: v1.…</div>
            <h3>The commit carries the evidence</h3>
            <p>
              One trailer binds repository, tree, parents, base, policy digest, pipeline digest, and per-suite
              results. Change any of them and verification fails closed.
            </p>
          </div>
          <div className="thwip-step">
            <div className="k">merge_group ✓</div>
            <h3>GitHub verifies and merges</h3>
            <p>
              A ruleset-protected check reads the exact head commit, fetches one signed fact bundle, and verifies on
              the runner. Green in seconds; the queue merges. CI never reruns in the cloud.
            </p>
          </div>
        </div>
      </section>

      <section className="thwip-section" id="outcomes">
        <p className="thwip-eyebrow">Honest security</p>
        <h2>Every verification ends in a stable code</h2>
        <p className="lede">
          A proof signed by a revoked key, an old policy, or somebody else's tree fails closed, with the same code
          every time.
        </p>
        <table className="gp-data-table">
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Proof copied onto different code</td>
              <td className="bad">SUBJECT_TREE_MISMATCH</td>
            </tr>
            <tr>
              <td>Rebase or squash after signing</td>
              <td className="bad">SUBJECT_ANCESTRY_MISMATCH</td>
            </tr>
            <tr>
              <td>Signer lost repository access</td>
              <td className="bad">SIGNER_PERMISSION_INSUFFICIENT</td>
            </tr>
            <tr>
              <td>Key revoked five seconds ago</td>
              <td className="bad">SIGNER_KEY_REVOKED</td>
            </tr>
            <tr>
              <td>Pipeline changed by the PR it judges</td>
              <td className="bad">PIPELINE_DIGEST_MISMATCH</td>
            </tr>
            <tr>
              <td>The exact tree, the active policy, a current signer</td>
              <td className="ok">PASS</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="thwip-section" id="pricing">
        <p className="thwip-eyebrow">Pricing</p>
        <h2>Both plans verify the same way. Pro raises the limits.</h2>
        <div className="thwip-plan-grid">
          <div className="thwip-plan">
            <p className="thwip-plan__name">Free</p>
            <p className="thwip-plan__price">
              $0<span className="thwip-plan__cadence"> forever</span>
            </p>
            <ul className="thwip-plan__list">
              <li>3 active projects</li>
              <li>5 active signers</li>
              <li>All security profiles</li>
              <li>Merge-queue verification</li>
            </ul>
            <button className="gp-btn" onClick={() => void signInWithGitHub("/dashboard")}>
              Start free
            </button>
          </div>
          <div className="thwip-plan thwip-plan--pro">
            <p className="thwip-plan__name">Pro</p>
            <p className="thwip-plan__price">
              $5<span className="thwip-plan__cadence">/month · $50/year</span>
            </p>
            <ul className="thwip-plan__list">
              <li>15 active projects</li>
              <li>25 active signers</li>
              <li>Same verification, same profiles</li>
              <li>Priority support</li>
            </ul>
            <button className="gp-btn" onClick={() => void signInWithGitHub("/dashboard/billing")}>
              Upgrade in dashboard
            </button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function FaqPage({ me }: { me: Me | null | undefined }) {
  return (
    <div className="thwip-shell">
      <SiteNav me={me} />
      <section className="thwip-section" style={{ borderTop: "none" }}>
        <p className="thwip-eyebrow">FAQ</p>
        <h2>Frequently asked questions</h2>
        <p className="lede">
          Agents: this page is also at <a href="/faq.md">/faq.md</a>, with a site overview at{" "}
          <a href="/llms.txt">/llms.txt</a>.
        </p>
        <dl className="thwip-faq">
          <dt>What are the security profiles: fast, fresh, audited, remote?</dt>
          <dd>
            <b>Fast</b>: a signed local proof with no pre-run contact with the control plane. Works fully offline
            before push. <b>Fresh</b>: the CLI first requests a short-lived lease bound to the exact tree, signer,
            and policy, so the proof also carries a trusted issuance window. <b>Audited</b>: fresh, plus a random or
            risk-triggered independent rerun of the pipeline in GitHub Actions to deter false assertions.{" "}
            <b>Remote</b>: the pipeline runs in GitHub for every required check, which is conventional remote CI.
            Pick a profile per project in the dashboard or in <code>thwip.yaml</code>.
          </dd>
          <dt>What does a proof actually prove?</dt>
          <dd>
            That an enrolled signing key asserted the approved pipeline and required suites passed for this exact
            repository, Git tree, ancestry, base, and policy version. In fast and fresh profiles the execution claim
            is the signer's assertion; audited and remote add independent execution evidence.
          </dd>
          <dt>How does a teammate join?</dt>
          <dd>
            They sign in with GitHub. Membership, roles, and repository permissions come from the GitHub
            organization, so there are no invitations to manage. Outside collaborators invited to individual
            repositories on GitHub count too, with their per-repository permission as their standing. Verification
            always checks current GitHub permission, so removing someone on GitHub removes their standing here too.
          </dd>
          <dt>Do commits have to be signed?</dt>
          <dd>
            The proof is its own signature and does not depend on git commit signatures. If you want signed commits
            too, <code>thwip init</code> can configure git to sign with the same enrolled SSH key, and your ruleset
            can additionally require signed commits.
          </dd>
          <dt>What happens on a rebase or squash?</dt>
          <dd>
            The proof binds the exact tree and ancestry, so a rebase, squash, or cherry-pick needs a new{" "}
            <code>thwip run</code>. The merge queue is configured with the MERGE method so the trailer survives into
            the merge group, where every member PR's head proof is verified again.
          </dd>
          <dt>Where do project settings live?</dt>
          <dd>
            In <code>thwip.yaml</code>, committed to the repository: suites, security profile, and policy knobs. The
            dashboard mirrors it. Policy changes activate through review, and a pull request can never approve its
            own policy change.
          </dd>
          <dt>What data does the control plane hold?</dt>
          <dd>
            Organization and permission projections from GitHub, enrolled public keys, immutable policy versions,
            and verification outcomes. No source code, no logs, no artifacts, and never a private key.
          </dd>
        </dl>
      </section>
      <SiteFooter />
    </div>
  );
}

const INSTALL_PROMPT = `You are installing thwip (verified local CI) into this project.
Work step by step and ask the human before each side-effectful step.

1. Install the CLI: clone https://github.com/recallnet/thwip and run
   "pnpm install && pnpm build", then link packages/cli (or run it via
   "node packages/cli/dist/main.js"). Confirm with: thwip --help
2. Authenticate: run "thwip login". It prints a URL and a short code.
   Show the human the URL so they can click it (it works over SSH; the
   browser opens on their machine, not yours). Wait until the CLI
   reports it is signed in.
3. Enroll this machine's signing key: generate a dedicated key with
   "ssh-keygen -t ed25519 -f ~/.config/thwip/keys/<device> -N ''" after
   asking the human to name the device, then run
   "thwip keys enroll --public-key ~/.config/thwip/keys/<device>.pub --label <device>".
4. Set up the project: ask the human which checks make up CI here
   (for example lint, typecheck, test), then write thwip.yaml at the
   repository root declaring those suites and the security profile
   (start with "fast"; see https://thwip.recall.net/faq for profiles).
   Commit it on a branch and open a pull request.
5. Ask the human (an org owner) to enable the project and activate the
   policy in the dashboard at https://thwip.recall.net/dashboard.
6. Prove the loop: make a small change, run "thwip run", push, and
   open a PR. The thwip check should pass from the proof on the head
   commit without rerunning CI remotely.

Rules: never generate or upload a private key anywhere except the
human's ~/.config/thwip directory; never bypass a failing suite; if
"thwip run" refuses to sign, report the reason code to the human
instead of working around it.`;

function InstallPage({ me }: { me: Me | null | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="thwip-shell">
      <SiteNav me={me} />
      <section className="thwip-section" style={{ borderTop: "none" }}>
        <p className="thwip-eyebrow">Install</p>
        <h2>Installation is an agent prompt</h2>
        <p className="lede">
          Paste this into your coding agent. It installs the CLI, signs you in with a click-through device code
          (works over SSH), and sets up the project with your approval at each step. Raw copy at{" "}
          <a href="/install.md">/install.md</a>.
        </p>
        <div className="gp-panel">
          <div className="gp-panel__header">
            <h3 className="gp-panel__title">Agent prompt</h3>
            <button
              className="gp-btn gp-btn--sm"
              onClick={() => {
                void navigator.clipboard.writeText(INSTALL_PROMPT).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="gp-panel__body">
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem", margin: 0 }}>{INSTALL_PROMPT}</pre>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}

/* ---------- dashboard ---------- */

const TABS = [
  ["overview", "Overview"],
  ["projects", "Projects"],
  ["people", "People & Teams"],
  ["devices", "Devices"],
  ["policies", "Policies"],
  ["billing", "Billing"],
  ["operations", "Operations"],
] as const;

function OrgSwitcher({ me }: { me: Me }) {
  if (me.organizations.length <= 1) {
    return <span className="gp-chip">{me.organization?.github_login ?? "no org"}</span>;
  }
  return (
    <select
      className="gp-btn gp-btn--sm"
      aria-label="Organization"
      value={selectedOrg() ?? me.organization?.github_login ?? ""}
      onChange={(e) => {
        localStorage.setItem("thwip.org", e.target.value);
        window.location.reload();
      }}
    >
      {me.organizations.map((o) => (
        <option key={o.githubOrgId} value={o.githubLogin}>
          {o.githubLogin}
        </option>
      ))}
    </select>
  );
}

function Dashboard({ me, tab }: { me: Me; tab: string }) {
  const org = me.organization;
  return (
    <div className="thwip-shell gp-workspace">
      <nav className="thwip-nav" aria-label="Dashboard">
        <a className="thwip-brand" href="/">
          thwip<small>DASHBOARD</small>
        </a>
        <span className="links">
          <OrgSwitcher me={me} />
          {org && <span className="gp-chip">{org.plan}</span>}
          <span className="gp-panel__meta">{me.principal?.github_login ?? me.viewer.githubUserId}</span>
          <button
            className="gp-btn gp-btn--sm"
            onClick={() =>
              void api("/api/auth/sign-out", { method: "POST", body: "{}" }).then(() => (window.location.href = "/"))
            }
          >
            Sign out
          </button>
        </span>
      </nav>
      <ul className="tab-nav" role="tablist" style={{ marginTop: "1rem" }}>
        {TABS.map(([key, label]) => (
          <li key={key}>
            <a href={`/dashboard/${key}`} className={tab === key ? "is-active" : ""}>
              {label}
            </a>
          </li>
        ))}
      </ul>
      <main className="gp-workspace__content">
        {!org && (
          <div className="gp-panel" style={{ marginBottom: "1rem" }}>
            <div className="gp-panel__header">
              <h3 className="gp-panel__title">Connect your GitHub organization</h3>
            </div>
            <div className="gp-panel__body">
              <p>
                Your GitHub account is not part of a synced thwip organization yet. Install the thwip GitHub App on
                the organization, then run a sync from Operations.
              </p>
            </div>
          </div>
        )}
        {tab === "overview" && <Overview />}
        {tab === "projects" && <Projects me={me} />}
        {tab === "people" && <People />}
        {tab === "devices" && <Devices me={me} />}
        {tab === "policies" && <Policies />}
        {tab === "billing" && <Billing />}
        {tab === "operations" && <Operations me={me} />}
      </main>
    </div>
  );
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="gp-panel" style={{ marginBottom: "1rem" }}>
      <div className="gp-panel__header">
        <h3 className="gp-panel__title">{title}</h3>
        {meta && <span className="gp-panel__meta">{meta}</span>}
      </div>
      <div className="gp-panel__body">{children}</div>
    </div>
  );
}

function Overview() {
  const { data, error } = useFetch<{
    plan: string;
    limits: { projects: number; users: number };
    projects: number;
    enabledProjects: number;
    members: number;
    activatedUsers: number;
    teams: number;
    activeKeys: number;
  }>("/v1/dashboard/summary");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  const items: Array<[string, string]> = [
    ["enabled projects", `${data.enabledProjects}/${data.limits.projects}`],
    ["active users", `${data.activatedUsers}/${data.limits.users}`],
    ["github members", String(data.members)],
    ["github teams", String(data.teams)],
    ["signing keys", String(data.activeKeys)],
    ["plan", data.plan],
  ];
  return (
    <>
      <div className="metric-strip">
        {items.map(([label, value]) => (
          <div className="metric-strip__item" key={label}>
            <span className="metric-strip__label">{label}</span>
            <span className="metric-strip__value">{value}</span>
          </div>
        ))}
      </div>
      <Panel title="Ship a change">
        <p style={{ fontFamily: "var(--gp-mono, monospace)", fontSize: "0.82rem" }}>
          git checkout -b change · edit · commit · <b>thwip run</b> · git push · gh pr create
        </p>
        <p className="gp-panel__meta">The merge queue merges once the proof on the head commit verifies.</p>
      </Panel>
    </>
  );
}

interface ProjectRow {
  id: string;
  github_repository_id: string;
  github_name: string;
  default_branch: string;
  enabled: number;
  active_policy_digest: string | null;
  policy_version: number | null;
  policy_profile: string | null;
  collaborators: number;
  last_outcome: string | null;
  last_observed_at: string | null;
}

function Projects({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  const installUrl = me.organization?.installation_id
    ? `https://github.com/organizations/${me.organization.github_login}/settings/installations/${me.organization.installation_id}`
    : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (p: ProjectRow, action: "enable" | "disable") => {
    setBusy(p.id);
    setActionError(null);
    try {
      await api(`/v1/dashboard/projects/${p.id}/${action}`, { method: "POST", body: "{}" });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  return (
    <Panel title="Projects" meta="enabling consumes plan quota; requires repository admin on GitHub">
      {installUrl && (
        <div className="thwip-add-repos">
          <a className="gp-btn gp-btn--sm" href={installUrl} target="_blank" rel="noreferrer">
            Add repositories on GitHub
          </a>
          <span className="gp-panel__meta">
            Grant the thwip App access to a repository there; it imports here automatically, then you enable it.
          </span>
        </div>
      )}
      {actionError && <p className="thwip-error">{actionError}</p>}
      {data.projects.length === 0 && <p>No repositories imported yet. Run a sync from Operations.</p>}
      <table className="gp-data-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Status</th>
            <th>Active policy</th>
            <th>Last verification</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.projects.map((p) => (
            <tr key={p.id}>
              <td>
                <code>{p.github_name}</code>
                <div className="gp-panel__meta">
                  {p.collaborators} collaborators · {p.default_branch}
                </div>
              </td>
              <td>{p.enabled ? <span className="gp-chip is-active">enabled</span> : <span className="gp-chip">imported</span>}</td>
              <td title={p.active_policy_digest ?? undefined}>
                {p.policy_version ? (
                  <>
                    v{p.policy_version} · {p.policy_profile ?? "fast"}
                    <div className="gp-panel__meta">from thwip.yaml</div>
                  </>
                ) : (
                  <span className="gp-panel__meta">none activated</span>
                )}
              </td>
              <td>
                {p.last_outcome ? (
                  <span className={p.last_outcome === "PASS" ? "ok" : "bad"}>{p.last_outcome}</span>
                ) : (
                  <span className="gp-panel__meta">—</span>
                )}
              </td>
              <td>
                <button
                  className="gp-btn gp-btn--sm"
                  disabled={busy === p.id}
                  onClick={() => void act(p, p.enabled ? "disable" : "enable")}
                >
                  {p.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function People() {
  const { data, error } = useFetch<{
    members: Array<{
      github_user_id: string;
      github_login: string;
      github_org_role: string | null;
      activated_at: string | null;
      active_keys: number;
    }>;
    teams: Array<{ team_id: string; slug: string; name: string; members: number; repos: number }>;
    teamMembers: Array<{ team_id: string; github_user_id: string; github_login: string | null }>;
    grants: Array<{ github_name: string; github_login: string; permission: string; active: number }>;
  }>("/v1/dashboard/people");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  return (
    <>
      <Panel title="Members" meta="imported from GitHub; roles and permissions are GitHub's">
        <table className="gp-data-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>GitHub role</th>
              <th>Seat</th>
              <th>Keys</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.github_user_id}>
                <td>
                  <code>{m.github_login}</code>
                </td>
                <td>{m.github_org_role === "outside" ? <span className="gp-chip">outside collaborator</span> : (m.github_org_role ?? "member")}</td>
                <td>{m.activated_at ? <span className="gp-chip is-active">active</span> : <span className="gp-chip">shadow</span>}</td>
                <td>{m.active_keys}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="gp-panel__meta" style={{ marginTop: "0.6rem" }}>
          There are no invitations. A member signs in with GitHub and gets exactly the access their GitHub role and
          repository permissions already grant. Outside collaborators invited to individual repositories on GitHub
          appear here too, marked as such, with the same per-repository standing.
        </p>
      </Panel>
      <Panel title="Teams">
        {data.teams.length === 0 && <p>No GitHub teams synced.</p>}
        <table className="gp-data-table">
          <tbody>
            {data.teams.map((t) => (
              <tr key={t.team_id}>
                <td>
                  <code>@{t.slug}</code>
                </td>
                <td>
                  {data.teamMembers
                    .filter((tm) => tm.team_id === t.team_id)
                    .map((tm) => tm.github_login ?? tm.github_user_id)
                    .join(", ")}
                </td>
                <td className="gp-panel__meta">{t.repos} repos</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Effective repository permissions">
        <table className="gp-data-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Member</th>
              <th>Permission</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.grants.map((g, i) => (
              <tr key={i}>
                <td>
                  <code>{g.github_name}</code>
                </td>
                <td>
                  <code>{g.github_login}</code>
                </td>
                <td>{g.permission}</td>
                <td>{g.active ? <span className="gp-chip is-active">current</span> : <span className="gp-chip">removed</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function Devices({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{
    devices: Array<{
      key_id: string;
      github_user_id: string;
      github_login: string | null;
      algorithm: string;
      fingerprint: string;
      device_label: string;
      created_at: string;
      revoked_at: string | null;
    }>;
  }>("/v1/dashboard/devices");
  const revoke = async (keyId: string) => {
    await api(`/v1/dashboard/devices/${keyId}/revoke`, { method: "POST", body: "{}" });
    reload();
  };
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  const canRevoke = (d: { github_user_id: string }) =>
    d.github_user_id === me.viewer.githubUserId || me.viewer.githubOrgRole === "owner";
  return (
    <Panel title="Signing devices" meta="thwip login, then thwip keys enroll; revocation applies on the next verification">
      <table className="gp-data-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Owner</th>
            <th>Key</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.devices.map((d) => (
            <tr key={d.key_id}>
              <td>{d.device_label}</td>
              <td>
                <code>{d.github_login ?? d.github_user_id}</code>
              </td>
              <td>
                <code style={{ fontSize: "0.72rem" }}>
                  {d.algorithm} · {d.fingerprint.slice(0, 24)}…
                </code>
              </td>
              <td>{d.revoked_at ? <span className="gp-chip">revoked</span> : <span className="gp-chip is-active">active</span>}</td>
              <td>
                {!d.revoked_at && canRevoke(d) && (
                  <button className="gp-btn gp-btn--sm" onClick={() => void revoke(d.key_id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Policies() {
  const { data, error } = useFetch<{
    policies: Array<{
      digest: string;
      github_name: string;
      version: number;
      status: string;
      created_at: string;
      activated_at: string | null;
    }>;
  }>("/v1/dashboard/policies");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  return (
    <Panel title="Policy history" meta="immutable, content-addressed; a PR can never approve its own policy change">
      <table className="gp-data-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Version</th>
            <th>Digest</th>
            <th>Status</th>
            <th>Activated</th>
          </tr>
        </thead>
        <tbody>
          {data.policies.map((p) => (
            <tr key={p.digest}>
              <td>
                <code>{p.github_name}</code>
              </td>
              <td>v{p.version}</td>
              <td>
                <code>{p.digest.slice(7, 23)}…</code>
              </td>
              <td>
                <span className={`gp-chip ${p.status === "active" ? "is-active" : ""}`}>{p.status}</span>
              </td>
              <td className="gp-panel__meta">{p.activated_at?.slice(0, 10) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Billing() {
  const { data, error, reload } = useFetch<{
    plan: string;
    limits: { projects: number; users: number };
    betterAuthOrgId: string | null;
    subscription: { plan: string; status: string; periodEnd: string | null } | null;
    isOwner: boolean;
  }>("/v1/dashboard/billing");
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const ensureBillingOrg = async (): Promise<string> => {
    if (data?.betterAuthOrgId) return data.betterAuthOrgId;
    const res = await api<{ betterAuthOrgId: string }>("/v1/organizations/link-billing", {
      method: "POST",
      body: "{}",
    });
    reload();
    return res.betterAuthOrgId;
  };

  const upgrade = async (annual: boolean) => {
    setWorking(true);
    setNote(null);
    try {
      const referenceId = await ensureBillingOrg();
      const res = await api<{ url?: string }>("/api/auth/subscription/upgrade", {
        method: "POST",
        body: JSON.stringify({
          plan: "pro",
          annual,
          referenceId,
          successUrl: "/dashboard/billing",
          cancelUrl: "/dashboard/billing",
        }),
      });
      if (res.url) window.location.href = res.url;
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const portal = async () => {
    setWorking(true);
    try {
      const referenceId = await ensureBillingOrg();
      const res = await api<{ url?: string }>("/api/auth/subscription/billing-portal", {
        method: "POST",
        body: JSON.stringify({ referenceId, returnUrl: "/dashboard/billing" }),
      });
      if (res.url) window.location.href = res.url;
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  return (
    <Panel title="Billing" meta="checkout and the customer portal are hosted by Stripe">
      <div className="metric-strip">
        <div className="metric-strip__item">
          <span className="metric-strip__label">plan</span>
          <span className="metric-strip__value">{data.plan}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__label">project limit</span>
          <span className="metric-strip__value">{data.limits.projects}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__label">user limit</span>
          <span className="metric-strip__value">{data.limits.users}</span>
        </div>
        {data.subscription && (
          <div className="metric-strip__item">
            <span className="metric-strip__label">subscription</span>
            <span className="metric-strip__value">{data.subscription.status}</span>
          </div>
        )}
      </div>
      {note && <p className="thwip-error">{note}</p>}
      {data.isOwner ? (
        data.plan === "free" ? (
          <div className="thwip-actions">
            <button className="gp-btn" disabled={working} onClick={() => void upgrade(false)}>
              Upgrade to Pro, $5/month
            </button>
            <button className="gp-btn" disabled={working} onClick={() => void upgrade(true)}>
              Annual, $50/year
            </button>
          </div>
        ) : (
          <button className="gp-btn" disabled={working} onClick={() => void portal()}>
            Manage billing
          </button>
        )
      ) : (
        <p className="gp-panel__meta">Only GitHub organization owners can change billing.</p>
      )}
    </Panel>
  );
}

function Operations({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{
    deliveries: Array<{ provider: string; delivery_id: string; event: string; received_at: string }>;
    observations: Array<{ github_name: string; head_sha: string; outcome: string; observed_at: string }>;
  }>("/v1/dashboard/operations");
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sync = async () => {
    setSyncing(true);
    setNote(null);
    try {
      const res = await api<{ synced: Record<string, number> }>("/v1/dashboard/sync", { method: "POST", body: "{}" });
      setNote(`Synced: ${JSON.stringify(res.synced)}`);
      reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  return (
    <>
      <Panel title="GitHub sync" meta="webhooks keep the projection warm; a full sync re-reads everything">
        {me.viewer.githubOrgRole === "owner" ? (
          <button className="gp-btn gp-btn--sm" disabled={syncing} onClick={() => void sync()}>
            {syncing ? "Syncing…" : "Run full sync"}
          </button>
        ) : (
          <p className="gp-panel__meta">Org owners can trigger a full sync.</p>
        )}
        {note && (
          <p className="gp-panel__meta" style={{ marginTop: "0.5rem" }}>
            <code>{note}</code>
          </p>
        )}
      </Panel>
      <Panel title="Recent verifications">
        {data.observations.length === 0 && <p>No verifications recorded yet.</p>}
        <table className="gp-data-table">
          <tbody>
            {data.observations.map((o, i) => (
              <tr key={i}>
                <td>
                  <code>{o.github_name}</code>
                </td>
                <td>
                  <code>{o.head_sha.slice(0, 12)}</code>
                </td>
                <td>
                  <span className={o.outcome === "PASS" ? "ok" : "bad"}>{o.outcome}</span>
                </td>
                <td className="gp-panel__meta">{o.observed_at.slice(0, 19)}Z</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Webhook deliveries">
        {data.deliveries.length === 0 && <p>No deliveries yet.</p>}
        <table className="gp-data-table">
          <tbody>
            {data.deliveries.map((d) => (
              <tr key={d.delivery_id}>
                <td>{d.provider}</td>
                <td>
                  <code>{d.event}</code>
                </td>
                <td className="gp-panel__meta">{d.received_at.slice(0, 19)}Z</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

/* ---------- device approval ---------- */

function DevicePage({ me }: { me: Me | null | undefined }) {
  const params = new URLSearchParams(window.location.search);
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const approve = async () => {
    setState("working");
    try {
      await api("/api/auth/device/approve", { method: "POST", body: JSON.stringify({ userCode: code.trim() }) });
      setState("done");
    } catch (e) {
      setMessage((e as Error).message);
      setState("error");
    }
  };
  if (me === null) {
    return (
      <div className="gp-panel thwip-device-card">
        <div className="gp-panel__header">
          <h3 className="gp-panel__title">Sign in to approve this device</h3>
        </div>
        <div className="gp-panel__body">
          <p>The thwip CLI is waiting for approval. Sign in with GitHub to continue.</p>
          <button
            className="gp-btn"
            onClick={() => void signInWithGitHub(`/device?user_code=${encodeURIComponent(code)}`)}
          >
            Sign in with GitHub
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="gp-panel thwip-device-card">
      <div className="gp-panel__header">
        <h3 className="gp-panel__title">Approve CLI sign-in</h3>
      </div>
      <div className="gp-panel__body">
        {state === "done" ? (
          <p className="ok">Device approved. Return to your terminal.</p>
        ) : (
          <>
            <p>
              Enter the code shown by <code>thwip login</code>.
            </p>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Device code" />
            {message && <p className="thwip-error">{message}</p>}
            <button className="gp-btn" disabled={state === "working" || code.length < 4} onClick={() => void approve()}>
              Approve device
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- router ---------- */

export function App() {
  const me = useMe();
  const path = window.location.pathname;
  const dashMatch = /^\/dashboard(?:\/([a-z]+))?/.exec(path);

  if (path.startsWith("/device")) return <DevicePage me={me} />;
  if (path.startsWith("/faq")) return <FaqPage me={me} />;
  if (path.startsWith("/install")) return <InstallPage me={me} />;
  if (dashMatch) {
    if (me === undefined) return <p className="gp-panel__meta" style={{ padding: "3rem" }}>Loading…</p>;
    if (me === null) {
      return (
        <div className="gp-panel thwip-device-card">
          <div className="gp-panel__header">
            <h3 className="gp-panel__title">Sign in to thwip</h3>
          </div>
          <div className="gp-panel__body">
            <p>The dashboard mirrors your GitHub organizations. Sign in with the account that belongs to them.</p>
            <button className="gp-btn" onClick={() => void signInWithGitHub(window.location.pathname)}>
              Sign in with GitHub
            </button>
          </div>
        </div>
      );
    }
    return <Dashboard me={me} tab={dashMatch[1] ?? "overview"} />;
  }
  return <Marketing me={me} />;
}
