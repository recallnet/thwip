import React, { useCallback, useEffect, useState } from "react";
import { developerSetupPrompt, projectSetupPrompt } from "@thwip/prompts";
import { Home } from "./Home.js";
import { SiteBar, SiteFoot } from "./Chrome.js";
import { QueuePanel } from "./Queue.js";
import { findProjectByGithubName, parseProjectPath, projectPath } from "./projectPath.js";

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
  appSlug: string;
}

/**
 * Client-side navigation for the dashboard.
 *
 * The tabs were plain links, so every tab click reloaded the whole application
 * and refetched the session. While that fetch was in flight the router rendered a
 * bare paragraph with no header and no tabs, which read as the page breaking.
 */
const NAVIGATED = "thwip:navigated";

function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATED, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATED, sync);
    };
  }, []);
  return path;
}

function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new Event(NAVIGATED));
}

/**
 * A link that stays inside the application. The href is real, so opening it in a
 * new tab, middle-clicking, and copying the address all keep working; only an
 * ordinary left click is intercepted.
 */
function NavLink({
  to,
  className,
  title,
  children,
}: {
  to: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={to}
      className={className}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
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

function FaqPage({ me }: { me: Me | null | undefined }) {
  return (
    <div className="nt">
      <div className="nt-page">
        <SiteBar me={me} signIn={() => void signInWithGitHub("/dashboard")} />
        <section className="nt-field">
          <div className="nt-label">
            Reference<b>Questions</b>
          </div>
          <div className="nt-body">
        <p className="nt-lede">
          Agents: this page is also at <a href="/faq.md">/faq.md</a>, with a site overview at{" "}
          <a href="/llms.txt">/llms.txt</a>.
        </p>
        <dl className="nt-qa">
          <dt>Can someone fake a proof?</dt>
          <dd>
            They can sign a claim without running the checks, the same way anyone can write "tests pass" in a pull
            request. What changes is the cost. They have to use a key enrolled to their GitHub account, spend the
            time the run would have taken, and state a fingerprint for every step. Those fingerprints are identical
            on every machine that runs the same code, so the claim has to keep agreeing with everyone else's runs
            forever. The first time it doesn't, the signed claim is the evidence.
          </dd>
          <dt>Does thwip watch my tests?</dt>
          <dd>
            No. thwip never sees your code and runs nothing. It checks that a signed claim matches the exact commit,
            the approved checks, and a signer who currently has access.
          </dd>
          <dt>Some changes are too important to take someone's word for.</dt>
          <dd>
            Set those paths to run in GitHub. GitHub signs the result, so the developer isn't the source of the
            claim. Most teams do this for auth, billing, deploy config, and lockfiles.
          </dd>
          <dt>How does this map to SLSA?</dt>
          <dd>
            The remote profile is SLSA Build L3: GitHub Actions performs the build and GitHub signs the provenance
            with an identity the workflow can't forge. fast and fresh are deliberately not L3 — they're attributed
            assertions plus the controls SLSA's original L4 asked for and v1.0 dropped as impractical: hermetic
            execution, reproducible outputs, and optional two-party agreement. Those are cheap here because the
            pipeline runs as a content-addressed graph, so identical inputs must produce identical digests on any
            machine. Pick per path: L3 where a rerun is worth the minutes, reproducibility-backed assertions
            everywhere else.
          </dd>
          <dt>What are the security profiles: fast, fresh, audited, remote?</dt>
          <dd>
            <b>Fast</b>: a signed local proof with no pre-run contact with the control plane. Works fully offline
            before push. <b>Fresh</b>: the CLI first requests a short-lived lease bound to the exact tree, signer,
            and policy, so the proof also carries a trusted issuance window. <b>Audited</b>: fresh, plus a random or
            risk-triggered independent rerun of the pipeline in GitHub Actions to deter false assertions.{" "}
            <b>Remote</b>: the pipeline runs in GitHub for every required check, which is conventional remote CI.
            Pick organization defaults in the dashboard; use <code>thwip.yaml</code> only where a repository needs
            to override them.
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
          <dt>Where do signing keys come from?</dt>
          <dd>
            GitHub. thwip does not issue, store, or enroll keys — it reads the signing keys you have registered on
            your GitHub account, and a proof names a key by its OpenSSH fingerprint, which anyone can compute from
            the public key. Run <code>thwip keys status</code> to see which key on your machine would sign and
            whether GitHub lists it. Removing a key from GitHub stops it verifying; an organization can also deny a
            key from the dashboard for faster revocation.
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
            Organization proof defaults live in the dashboard. A repository may commit a partial{" "}
            <code>thwip.yaml</code> whose fields override those defaults after the file reaches the protected
            default branch. Candidate pull-request configuration is never used to approve itself.
          </dd>
          <dt>Who publishes the required proof check?</dt>
          <dd>
            The thwip GitHub App evaluates the exact pull-request head or merge-group members and publishes the{" "}
            <code>thwip</code> check directly. Projects start with a distinct{" "}
            <code>thwip / proof (observe)</code> check; enforce it only after an observed PASS. Every evaluation has
            a service-signed, immutable audit record.
          </dd>
          <dt>What data does the control plane hold?</dt>
          <dd>
            Organization and permission projections from GitHub, enrolled public keys, immutable policy versions,
            and verification outcomes. No source code, no logs, no artifacts, and never a private key.
          </dd>
            </dl>
          </div>
        </section>
        <SiteFoot />
      </div>
    </div>
  );
}

const INSTALL_PROMPT = developerSetupPrompt();

function InstallPage({ me }: { me: Me | null | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="nt">
      <div className="nt-page">
        <SiteBar me={me} signIn={() => void signInWithGitHub("/dashboard")} />
        <section className="nt-field">
          <div className="nt-label">
            Install<b>Developer setup</b>
          </div>
          <div className="nt-body">
            <h2>Setting up your machine is a prompt, not a checklist.</h2>
            <p>
              Paste this into your coding agent. It installs the CLI, signs you in through a device code that
              works over SSH, and stops for your approval at every step that changes a file or your GitHub
              account. Raw copy at <a href="/install.md">/install.md</a>.
            </p>
            <figure className="nt-record">
              <div className="nt-record__head">
                <span>Agent prompt</span>
                <button
                  className="nt-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(INSTALL_PROMPT).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="nt-prompt">{INSTALL_PROMPT}</pre>
            </figure>
          </div>
        </section>
        <SiteFoot />
      </div>
    </div>
  );
}

/* ---------- dashboard ---------- */

const TABS = [
  ["overview", "Overview"],
  ["projects", "Projects"],
  ["queue", "Queue"],
  ["people", "People & Teams"],
  ["policies", "Policies"],
  ["billing", "Billing"],
  ["operations", "Operations"],
] as const;

const ADD_ORG = "__add__";

function OrgSwitcher({ me }: { me: Me }) {
  const current = selectedOrg() ?? me.organization?.github_login ?? "";
  return (
    <select
      className="gp-btn gp-btn--sm"
      aria-label="Organization"
      value={current}
      onChange={(e) => {
        if (e.target.value === ADD_ORG) {
          window.open(`https://github.com/apps/${me.appSlug}/installations/new`, "_blank", "noreferrer");
          return;
        }
        localStorage.setItem("thwip.org", e.target.value);
        window.location.reload();
      }}
    >
      {me.organizations.length === 0 && <option value="">no organization</option>}
      {me.organizations.map((o) => (
        <option key={o.githubOrgId} value={o.githubLogin}>
          {o.githubLogin}
        </option>
      ))}
      <option value={ADD_ORG}>Add an organization…</option>
    </select>
  );
}

function Dashboard({
  me,
  tab,
  projectName,
  projectSection,
}: {
  me: Me;
  tab: string;
  projectName?: string;
  projectSection?: string;
}) {
  const org = me.organization;
  return (
    <div className="thwip-shell gp-workspace">
      <nav className="thwip-nav" aria-label="Dashboard">
        <a className="thwip-brand" href="/">
          thwip<small>DASHBOARD</small>
        </a>
        <span className="links">
          <OrgSwitcher me={me} />
          {org && (
            <a className="gp-chip" href="/dashboard/billing" title="Plan and limits">
              {org.plan}
            </a>
          )}
          <a href="/dashboard/profile" className="gp-panel__meta" title="Your keys and access">
            {me.principal?.github_login ?? me.viewer.githubUserId}
          </a>
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
            <NavLink to={`/dashboard/${key}`} className={tab === key ? "is-active" : ""}>
              {label}
            </NavLink>
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
        {tab === "projects" &&
          (projectName ? (
            <ProjectPage githubName={projectName} section={projectSection ?? "overview"} me={me} />
          ) : (
            <Projects me={me} />
          ))}
        {tab === "queue" && <QueueTab />}
        {tab === "people" && <People me={me} />}
        {tab === "profile" && <Profile me={me} />}
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


/** First thing a developer needs: a machine that can sign. */
function StartUsingThwip() {
  const [copied, setCopied] = useState(false);
  const prompt = developerSetupPrompt();
  return (
    <Panel title="Start using thwip" meta="developer setup · paste into your coding agent">
      <p style={{ marginBottom: "0.7rem" }}>
        Before you can sign a proof, this machine needs the CLI, a signed-in session, and an ed25519 key that GitHub
        lists as a <b>signing</b> key for your account. The prompt below walks an agent through all three and hands
        you the browser and terminal steps rather than doing them for you. Your private key is never read.
      </p>
      <div className="thwip-actions">
        <button
          className="gp-btn gp-btn--sm"
          onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy setup prompt"}
        </button>
        <a className="gp-btn gp-btn--sm" href="/install">
          Read it first
        </a>
      </div>
    </Panel>
  );
}

/** "2h ago" beats an ISO instant for a reader scanning a list. */
function relativeTime(iso: string): string {
  const at = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(at)) return iso;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
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
  const ops = useFetch<{
    observations: Array<{ github_name: string; head_sha: string; outcome: string; observed_at: string }>;
  }>("/v1/dashboard/operations");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;

  // Six equal numbers and no next step is what this was. Two of them are limits
  // that decide what you can do next, and the rest are counts nobody acts on, so
  // the limits lead and link to where they change.
  const atProjectLimit = data.enabledProjects >= data.limits.projects;
  const atUserLimit = data.activatedUsers >= data.limits.users;
  const recent = (ops.data?.observations ?? []).slice(0, 8);

  return (
    <>
      <div className="metric-strip">
        <a className="metric-strip__item" href="/dashboard/billing" title="Projects you may verify on this plan">
          <span className="metric-strip__label">enabled projects</span>
          <span className={`metric-strip__value${atProjectLimit ? " bad" : ""}`}>
            {data.enabledProjects}/{data.limits.projects}
          </span>
        </a>
        <a className="metric-strip__item" href="/dashboard/billing" title="People who may sign proofs on this plan">
          <span className="metric-strip__label">signers</span>
          <span className={`metric-strip__value${atUserLimit ? " bad" : ""}`}>
            {data.activatedUsers}/{data.limits.users}
          </span>
        </a>
        <a className="metric-strip__item" href="/dashboard/billing">
          <span className="metric-strip__label">plan</span>
          <span className="metric-strip__value">{data.plan}</span>
        </a>
      </div>

      {(atProjectLimit || atUserLimit) && (
        <Panel title="You are at your plan limit">
          <p>
            {atProjectLimit ? "Every project slot is in use. " : ""}
            {atUserLimit ? "Every signer seat is in use. " : ""}
            Enabling another needs a larger plan, or disabling one you no longer verify.
          </p>
          <p>
            <a className="gp-btn gp-btn--sm" href="/dashboard/billing">
              See plans
            </a>
          </p>
        </Panel>
      )}

      <Panel title="Latest verifications">
        {recent.length === 0 ? (
          <p className="gp-panel__meta">
            Nothing verified yet. Run <code>thwip run</code> on a commit and push it.
          </p>
        ) : (
          <table className="gp-data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Commit</th>
                <th>Result</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o, i) => (
                <tr key={i}>
                  <td>{o.github_name}</td>
                  <td>
                    <a
                      className="gp-mono"
                      href={`https://github.com/${o.github_name}/commit/${o.head_sha}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {o.head_sha.slice(0, 8)}
                    </a>
                  </td>
                  <td className={o.outcome === "PASS" ? "ok" : "bad"}>{o.outcome}</td>
                  <td className="gp-panel__meta">{relativeTime(o.observed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <StartUsingThwip />
      <Panel title="Ship a change">
        <p style={{ fontFamily: "var(--gp-mono, monospace)", fontSize: "0.82rem" }}>
          git checkout -b change · edit · commit · <b>thwip run</b> · git push · gh pr create
        </p>
        <p className="gp-panel__meta">
          The queue verifies the proof on your head commit, and under a profile stronger than fast it also runs
          the required suites against the merge commit before it merges.
        </p>
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
  activation_state: "disabled" | "awaiting_policy" | "active";
  active_policy_digest: string | null;
  policy_version: number | null;
  policy_profile: string | null;
  config_source: "global" | "repository-override" | "repository" | null;
  proof_check_mode: "observe" | "enforced";
  collaborators: number;
  last_outcome: string | null;
  last_observed_at: string | null;
}

function ProofDefaults({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useFetch<{ defaults: Record<string, unknown> | null }>(
    "/v1/dashboard/proof-defaults",
  );
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setText(
      JSON.stringify(
        data.defaults ?? {
          version: 1,
          profile: "fast",
          required: ["lint", "typecheck", "test"],
        },
        null,
        2,
      ),
    );
  }, [data]);
  const save = async (defaults: Record<string, unknown> | null) => {
    setSaving(true);
    setSaveError(null);
    try {
      await api("/v1/dashboard/proof-defaults", {
        method: "PUT",
        body: JSON.stringify({ defaults }),
      });
      reload();
    } catch (cause) {
      setSaveError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel
      title="Organization proof defaults"
      meta="repositories inherit these settings; committed thwip.yaml fields override them after protected merge"
    >
      {error && <p className="thwip-error">{error}</p>}
      <textarea
        aria-label="Organization proof defaults"
        value={text}
        disabled={!canEdit || saving}
        onChange={(event) => setText(event.target.value)}
        rows={9}
        style={{ width: "100%", fontFamily: "var(--gp-mono, monospace)", fontSize: "0.8rem" }}
      />
      {saveError && <p className="thwip-error">{saveError}</p>}
      {canEdit ? (
        <p>
          <button
            className="gp-btn gp-btn--sm"
            disabled={saving}
            onClick={() => {
              try {
                void save(JSON.parse(text) as Record<string, unknown>);
              } catch {
                setSaveError("defaults must be valid JSON");
              }
            }}
          >
            Save defaults
          </button>{" "}
          <button className="gp-btn gp-btn--sm" disabled={saving} onClick={() => void save(null)}>
            Clear defaults
          </button>
        </p>
      ) : (
        <p className="gp-panel__meta">Only a GitHub organization owner can change these defaults.</p>
      )}
    </Panel>
  );
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
  const setProofMode = async (p: ProjectRow, mode: "observe" | "enforced") => {
    setBusy(p.id);
    setActionError(null);
    try {
      await api(`/v1/dashboard/projects/${p.id}/proof-mode`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
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
    <>
      <ProofDefaults canEdit={me.viewer.githubOrgRole === "owner"} />
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
                <a href={projectPath(p.github_name)}>
                  <code>{p.github_name}</code>
                </a>
                <div className="gp-panel__meta">
                  {p.collaborators} with access · {p.default_branch} · App check {p.proof_check_mode}
                </div>
              </td>
              <td>
                {p.activation_state === "active" ? (
                  <span className="gp-chip is-active">enabled · active</span>
                ) : p.activation_state === "awaiting_policy" ? (
                  <span className="gp-chip is-active">enabled · awaiting policy</span>
                ) : (
                  <span className="gp-chip">imported · disabled</span>
                )}
              </td>
              <td title={p.active_policy_digest ?? undefined}>
                {p.policy_version ? (
                  <>
                    v{p.policy_version} · {p.policy_profile ?? "fast"}
                    <div className="gp-panel__meta">
                      {p.config_source === "global"
                        ? "from organization defaults"
                        : p.config_source === "repository-override"
                          ? "repository override over organization defaults"
                          : "from thwip.yaml"}
                    </div>
                  </>
                ) : (
                  <span className="gp-panel__meta">
                    {p.activation_state === "awaiting_policy"
                      ? `add organization defaults or activate from canonical ${p.default_branch}`
                      : "none activated"}
                  </span>
                )}
              </td>
              <td>
                {p.last_outcome ? (
                  <span
                    className={
                      p.last_outcome === "PASS" ? "ok" : p.last_outcome === "BOOTSTRAP_PENDING" ? undefined : "bad"
                    }
                  >
                    {p.last_outcome}
                  </span>
                ) : (
                  <span className="gp-panel__meta">—</span>
                )}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                {/*
                  One way in, and the one action worth doing from a list.
                  Everything else about a project — its queue, who can reach it,
                  how to set it up — lives on its own page rather than as another
                  button in a table cell.
                */}
                <a className="gp-btn gp-btn--sm" href={projectPath(p.github_name)}>
                  Open
                </a>{" "}
                <button
                  className={`gp-btn gp-btn--sm${p.enabled ? " gp-btn--quiet" : ""}`}
                  disabled={busy === p.id}
                  title={
                    p.enabled
                      ? "Stop verifying this repository. The check stops gating merges."
                      : "Start verifying this repository. Uses one of your plan's project slots."
                  }
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
    </>
  );
}

function People({ me }: { me: Me }) {
  const orgLogin = me.organization?.github_login ?? "";
  const { data, error } = useFetch<{
    members: Array<{
      github_user_id: string;
      github_login: string;
      github_org_role: string | null;
      activated_at: string | null;
    }>;
    teams: Array<{ team_id: string; slug: string; name: string; members: number; repos: number }>;
    teamMembers: Array<{ team_id: string; github_user_id: string; github_login: string | null }>;
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
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.github_user_id}>
                <td>
                  <a href={`https://github.com/${m.github_login}`} target="_blank" rel="noreferrer">
                    <code>{m.github_login}</code>
                  </a>
                </td>
                <td>{m.github_org_role === "outside" ? <span className="gp-chip">outside collaborator</span> : (m.github_org_role ?? "member")}</td>
                <td>{m.activated_at ? <span className="gp-chip is-active">active</span> : <span className="gp-chip">shadow</span>}</td>
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
                  <a href={`https://github.com/orgs/${orgLogin}/teams/${t.slug}`} target="_blank" rel="noreferrer">
                    <code>@{t.slug}</code>
                  </a>
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
    </>
  );
}

function buildSetupPrompt(p: {
  github_name: string;
  default_branch: string;
  enabled: number;
  policy_version: number | null;
}): string {
  return projectSetupPrompt({
    githubName: p.github_name,
    defaultBranch: p.default_branch,
    enabled: p.enabled === 1,
    hasActivePolicy: p.policy_version !== null,
  });
}
const PROJECT_SECTIONS = [
  ["overview", "Overview"],
  ["queue", "Queue"],
  ["access", "Access"],
  ["setup", "Set up"],
] as const;

/**
 * One page per project.
 *
 * A project used to be a row in a table with three buttons in it, and everything
 * about that project lived somewhere else: who could reach it behind a link, its
 * queue on an organization-wide tab stacked with every other project's, its setup
 * behind a button. Anyone asking "what is going on with this repository" had to
 * assemble the answer from four places.
 *
 * The organization tabs keep what is genuinely organization-wide — people,
 * policies, billing, plan limits. What belongs to one repository lives here.
 */
function ProjectPage({ githubName, section, me }: { githubName: string; section: string; me: Me }) {
  const { data, error, reload } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;

  const project = findProjectByGithubName(data.projects, githubName);
  if (!project) {
    return (
      <>
        <p style={{ marginBottom: "0.8rem" }}>
          <a href="/dashboard/projects">← Projects</a>
        </p>
        <p className="thwip-error">
          No project at <code>{githubName}</code>. Check the spelling, or it may have been removed from the
          organization.
        </p>
      </>
    );
  }

  return (
    <>
      <p style={{ marginBottom: "0.6rem" }}>
        <a href="/dashboard/projects">← Projects</a>
      </p>
      <h2 style={{ margin: "0 0 0.2rem", fontSize: "1.15rem" }}>
        <a href={`https://github.com/${project.github_name}`} target="_blank" rel="noreferrer">
          {project.github_name}
        </a>
      </h2>
      <p className="gp-panel__meta" style={{ marginBottom: "0.9rem" }}>
        {describeProject(project)}
      </p>
      <ul className="tab-nav" role="tablist" style={{ marginBottom: "1rem" }}>
        {PROJECT_SECTIONS.map(([key, label]) => (
          <li key={key}>
            <NavLink
              to={projectPath(project.github_name, key)}
              className={section === key ? "is-active" : ""}
            >
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
      {section === "overview" && <ProjectOverview project={project} reload={reload} />}
      {section === "queue" && (
        <QueuePanel
          repositoryId={project.github_repository_id}
          baseRef={`refs/heads/${project.default_branch}`}
          repositoryName={project.github_name}
        />
      )}
      {section === "access" && <ProjectAccess projectId={project.id} me={me} />}
      {section === "setup" && <ProjectSetup projectId={project.id} />}
    </>
  );
}

/** One line saying where this project stands, for the page header. */
function describeProject(p: ProjectRow): string {
  const parts: string[] = [];
  // Enabled and disabled are the same fact, so it is stated once.
  parts.push(
    p.activation_state === "active"
      ? `verifying · policy v${p.policy_version ?? "?"} · ${p.policy_profile ?? "unknown profile"}`
      : p.activation_state === "awaiting_policy"
        ? "enabled, waiting for a policy to activate"
        : "not enabled",
  );
  parts.push(`default branch ${p.default_branch}`);
  parts.push(`App check ${p.proof_check_mode}`);
  return parts.join(" · ");
}

function ProjectOverview({ project, reload }: { project: ProjectRow; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (action: "enable" | "disable" | "enforce") => {
    setBusy(true);
    setActionError(null);
    try {
      if (action === "enforce") {
        await api(`/v1/dashboard/projects/${project.id}/proof-mode`, {
          method: "POST",
          body: JSON.stringify({ mode: "enforced" }),
        });
      } else {
        await api(`/v1/dashboard/projects/${project.id}/${action}`, { method: "POST", body: "{}" });
      }
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Verification" meta="what the queue requires before this repository merges">
        <table className="gp-data-table">
          <tbody>
            <tr>
              <td>Active policy</td>
              <td>
                {project.activation_state === "active"
                  ? `v${project.policy_version ?? "?"} · ${project.policy_profile ?? ""}`
                  : "none activated"}
              </td>
            </tr>
            <tr>
              <td>Where it came from</td>
              <td>{describeConfigSource(project.config_source)}</td>
            </tr>
            <tr>
              <td>Last verification</td>
              <td>
                {project.last_outcome === null ? (
                  <span className="gp-panel__meta">nothing verified yet</span>
                ) : (
                  <span className={project.last_outcome === "PASS" ? "ok" : "bad"}>{project.last_outcome}</span>
                )}
              </td>
            </tr>
            <tr>
              <td>App-owned check</td>
              <td>
                {project.proof_check_mode === "enforced"
                  ? "enforced"
                  : "observing — it reports what it would have said, and blocks nothing"}
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      <Panel title="Actions" meta="enabling consumes plan quota; requires repository admin on GitHub">
        {actionError && <p className="thwip-error">{actionError}</p>}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {project.enabled === 1 ? (
            <button className="gp-btn gp-btn--sm" disabled={busy} onClick={() => void act("disable")}>
              Disable
            </button>
          ) : (
            <button className="gp-btn gp-btn--sm" disabled={busy} onClick={() => void act("enable")}>
              Enable
            </button>
          )}
          {project.enabled === 1 && project.proof_check_mode === "observe" && (
            <button className="gp-btn gp-btn--sm" disabled={busy} onClick={() => void act("enforce")}>
              Enforce App check
            </button>
          )}
        </div>
      </Panel>
    </>
  );
}

function describeConfigSource(source: ProjectRow["config_source"]): string {
  switch (source) {
    case "repository-override":
      return "repository override over organization defaults";
    case "repository":
      return "committed thwip.yaml";
    case "global":
      return "organization defaults";
    default:
      return "add organization defaults or activate from the canonical default branch";
  }
}

function ProjectSetup({ projectId }: { projectId: string }) {
  const { data, error } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  const [copied, setCopied] = useState(false);
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  const p = data.projects.find((x) => x.id === projectId);
  if (!p) return <p className="thwip-error">unknown project</p>;
  const prompt = buildSetupPrompt(p);
  return (
    <>
      <Panel
        title={`Set up ${p.github_name}`}
        meta="paste into your coding agent, in a checkout of this repository"
      >
        <p style={{ marginBottom: "0.8rem" }}>
          The agent installs the CLI, signs you in, resolves organization defaults, proposes only the repository
          overrides this project needs, proves the App-owned check in observe mode, and guides a no-gap ruleset
          cutover before proposing which GitHub Actions jobs to retire. Re-running it is safe.
        </p>
        <button
          className="gp-btn gp-btn--sm"
          onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy prompt"}
        </button>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.76rem", marginTop: "0.9rem" }}>{prompt}</pre>
      </Panel>
    </>
  );
}

function ProjectAccess({ projectId, me }: { projectId: string; me: Me }) {
  const orgLogin = me.organization?.github_login ?? "";
  const { data, error } = useFetch<{
    project: { id: string; github_name: string };
    grants: Array<{
      github_user_id: string;
      github_login: string;
      permission: string;
      active: number;
      synced_at: string;
      github_org_role: string | null;
    }>;
    teams: Array<{ slug: string; name: string; permission: string }>;
  }>(`/v1/dashboard/projects/${projectId}/access`);
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;
  return (
    <>
      <Panel title={`Access · ${data.project.github_name}`} meta="from GitHub; who may sign a proof for this repository">
        <table className="gp-data-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Org role</th>
              <th>Permission</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.grants.map((g) => (
              <tr key={g.github_user_id}>
                <td>
                  <a href={`https://github.com/${g.github_login}`} target="_blank" rel="noreferrer">
                    <code>{g.github_login}</code>
                  </a>
                </td>
                <td>
                  {g.github_org_role === "outside" ? (
                    <span className="gp-chip">outside collaborator</span>
                  ) : (
                    (g.github_org_role ?? "member")
                  )}
                </td>
                <td>{g.permission}</td>
                <td>
                  {g.active ? <span className="gp-chip is-active">current</span> : <span className="gp-chip">removed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {data.teams.length > 0 && (
        <Panel title="Teams with access">
          <table className="gp-data-table">
            <tbody>
              {data.teams.map((t) => (
                <tr key={t.slug}>
                  <td>
                    <a href={`https://github.com/orgs/${orgLogin}/teams/${t.slug}`} target="_blank" rel="noreferrer">
                      <code>@{t.slug}</code>
                    </a>
                  </td>
                  <td>{t.name}</td>
                  <td>{t.permission}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}

function Profile({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{
    principal: { github_login: string; github_org_role: string | null; activated_at: string | null } | null;
    githubUserId: string;
    organizations: OrgSummary[];
    registered: Array<{ fingerprint: string; title: string; githubKeyId: number }>;
    githubError: string | null;
    seen: Array<{
      key_id: string;
      algorithm: string;
      fingerprint: string;
      device_label: string;
      created_at: string;
      revoked_at: string | null;
      source: string;
    }>;
    access: Array<{ github_name: string; permission: string; active: number }>;
  }>("/v1/dashboard/profile");
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const prompt = developerSetupPrompt();

  const deny = async (keyId: string) => {
    await api(`/v1/dashboard/devices/${keyId}/revoke`, { method: "POST", body: "{}" });
    reload();
  };

  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;

  const login = data.principal?.github_login ?? data.githubUserId;
  const seenByFingerprint = new Map(data.seen.map((k) => [k.fingerprint, k]));

  return (
    <>
      <Panel
        title={login}
        meta={`GitHub user ${data.githubUserId}${data.principal?.github_org_role ? ` · ${data.principal.github_org_role}` : ""}`}
      >
        <p>
          Only you can see this page. Keys are personal, and GitHub is the authority for which of them are valid —
          thwip reads your registered signing keys rather than keeping a directory of its own.
        </p>
      </Panel>

      <Panel title="Devices and keys" meta="registered with GitHub as signing keys">
        {data.githubError && <p className="thwip-error">Could not read GitHub: {data.githubError}</p>}
        {data.registered.length === 0 && !data.githubError && (
          <p>
            GitHub lists no signing keys for {login}, so nothing on any machine can sign a proof for you yet. Add a
            device below.
          </p>
        )}
        {data.registered.length > 0 && (
          <table className="gp-data-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Fingerprint</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.registered.map((k) => {
                const cached = seenByFingerprint.get(k.fingerprint);
                return (
                  <tr key={k.fingerprint}>
                    <td>{k.title}</td>
                    <td>
                      <code style={{ fontSize: "0.72rem" }}>{k.fingerprint}</code>
                    </td>
                    <td>
                      {cached?.revoked_at ? (
                        <span className="gp-chip">denied here</span>
                      ) : (
                        <span className="gp-chip is-active">on GitHub</span>
                      )}
                    </td>
                    <td>
                      {cached && !cached.revoked_at && (
                        <button className="gp-btn gp-btn--sm" onClick={() => void deny(cached.key_id)}>
                          Deny in this org
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="gp-panel__meta" style={{ marginTop: "0.7rem" }}>
          Add or remove keys in{" "}
          <a href="https://github.com/settings/keys" target="_blank" rel="noreferrer">
            your GitHub settings
          </a>
          . Denying here blocks a key in this organization without touching your GitHub account.
        </p>
      </Panel>

      <Panel title="Add a device" meta="paste into the coding agent on that machine">
        <p style={{ marginBottom: "0.7rem" }}>
          Setting up another machine means installing the CLI there, signing in, and registering that machine&apos;s
          key with GitHub as a <b>signing</b> key. The prompt below walks an agent through it and hands you the
          browser and terminal steps; your private key is never read. Existing devices keep working.
        </p>
        <div className="thwip-actions">
          <button
            className="gp-btn gp-btn--sm"
            onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy prompt"}
          </button>
          <button className="gp-btn gp-btn--sm" onClick={() => setShowPrompt((v) => !v)}>
            {showPrompt ? "Hide" : "Show"} prompt
          </button>
        </div>
        {showPrompt && (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.76rem", marginTop: "0.8rem" }}>{prompt}</pre>
        )}
      </Panel>

      {data.seen.some((k) => k.source !== "github") && (
        <Panel title="Superseded" meta="keys from before GitHub became the authority; kept so old proofs stay explainable">
          <table className="gp-data-table">
            <tbody>
              {data.seen
                .filter((k) => k.source !== "github")
                .map((k) => (
                  <tr key={k.key_id}>
                    <td>{k.device_label}</td>
                    <td>
                      <code style={{ fontSize: "0.72rem" }}>{k.fingerprint}</code>
                    </td>
                    <td className="gp-panel__meta">cannot sign</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Your access" meta="from GitHub; this is what your proofs may cover">
        <table className="gp-data-table">
          <tbody>
            {data.access.map((g, i) => (
              <tr key={i}>
                <td>
                  <a href={`https://github.com/${g.github_name}`} target="_blank" rel="noreferrer">
                    <code>{g.github_name}</code>
                  </a>
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
      const userCode = code.trim().toUpperCase();
      // Better Auth requires the signed-in browser to claim the code before
      // approving it; approving without this returns invalid_request.
      await api(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
      await api("/api/auth/device/approve", { method: "POST", body: JSON.stringify({ userCode }) });
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

/**
 * The queue tab. One queue exists per repository and base branch, so this lists
 * the enabled projects and shows the queue for each project's default branch —
 * a single combined view would hide that `main` and `release` are independent
 * protected resources (plan.md §6.1).
 */
function QueueTab() {
  const { data, error } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;

  const enabled = data.projects.filter((p) => p.enabled === 1);
  if (enabled.length === 0) {
    return (
      <div className="gp-panel">
        <div className="gp-panel__body">
          <p className="gp-panel__meta">
            No project is enabled yet. Enable one under Projects, then run <code>thwip ship --wait</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {enabled.map((project) => (
        <QueuePanel
          key={project.id}
          repositoryId={project.github_repository_id}
          baseRef={`refs/heads/${project.default_branch}`}
          repositoryName={project.github_name}
        />
      ))}
    </>
  );
}

/* ---------- router ---------- */

export function App() {
  const me = useMe();
  const path = usePath();
  const projectMatch = parseProjectPath(path);
  const dashMatch = /^\/dashboard(?:\/([a-z]+))?/.exec(path);

  if (path.startsWith("/device")) return <DevicePage me={me} />;
  if (path.startsWith("/faq")) return <FaqPage me={me} />;
  if (path.startsWith("/install")) return <InstallPage me={me} />;
  if (dashMatch) {
    // Keep the frame while the session loads. Returning a bare paragraph here
    // dropped the header and the tabs on every cold load of a dashboard page.
    if (me === undefined) {
      return (
        <div className="thwip-shell gp-workspace">
          <nav className="thwip-nav" aria-label="Dashboard">
            <a className="thwip-brand" href="/">
              thwip<small>DASHBOARD</small>
            </a>
          </nav>
          <main className="gp-workspace__content">
            <p className="gp-panel__meta" style={{ padding: "3rem 0" }}>
              Loading your organization…
            </p>
          </main>
        </div>
      );
    }
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
    if (projectMatch) {
      return (
        <Dashboard
          me={me}
          tab="projects"
          projectName={projectMatch.githubName}
          projectSection={projectMatch.section}
        />
      );
    }
    return <Dashboard me={me} tab={dashMatch[1] ?? "overview"} />;
  }
  return <Home me={me} signIn={() => void signInWithGitHub("/dashboard")} />;
}
