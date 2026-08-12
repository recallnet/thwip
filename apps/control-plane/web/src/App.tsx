import React, { useEffect, useState } from "react";
import { developerSetupPrompt, projectSetupPrompt } from "@thwip/prompts";
import faqSource from "../public/faq.md?raw";
import { parseFaq, renderBlocks } from "./faq.js";
import { Home } from "./Home.js";
import { SiteBar, SiteFoot } from "./Chrome.js";
import { QueuePanel } from "./Queue.js";
import {
  documentOf,
  formOf,
  formRefusal,
  hasFieldsBeyondTheForm,
  PROFILES,
  type FormState,
  type Profile,
} from "./proofDefaults.js";
import { findProjectByGithubName, parseProjectPath, projectPath } from "./projectPath.js";
import { api, selectedOrg, useFetch, withOrg } from "./api.js";
import { durationText, metricHistory, type ReusedCiMetrics } from "./metrics.js";
import { Chip, ConfirmAction, Facts, OutcomeText, Panel, StatusChip } from "./ui.js";
import {
  activationText,
  configSourceText,
  entryStateText,
  outcome,
  proofCheckModeText,
  whenText,
} from "./vocabulary.js";

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
          {parseFaq(faqSource).map(({ question, answer, slug }) => (
            <React.Fragment key={question}>
              <dt id={slug}>{question}</dt>
              <dd>{renderBlocks(answer)}</dd>
            </React.Fragment>
          ))}
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
            <h2>Machine setup is a prompt, not a checklist.</h2>
            <p>
              Paste this prompt into your coding agent. The prompt installs the CLI. It signs you in with a device
              code that works over SSH. It stops at each step that changes a file or your GitHub account, and waits
              for your approval. Raw copy at <a href="/install.md">/install.md</a>.
            </p>
            <p>What the prompt does:</p>
            <ol className="nt-steps">
              <li>
                <b>Install the CLI.</b> One global install of <code>@recallnet/thwip</code>. The command is{" "}
                <code>thwip</code>. Node 22 or newer is required.
              </li>
              <li>
                <b>Sign in.</b> <code>thwip login</code> prints a URL and a short code. You open the URL in your
                own browser and approve. The session belongs to you, not to the agent.
              </li>
              <li>
                <b>Register a signing key.</b> <code>thwip keys status</code> says which key would sign. It also
                says whether GitHub lists the key as a <b>signing</b> key. The most common mistake is to register
                the key as an authentication key. Thwip reads signing keys only.{" "}
                <a href="/faq#where-do-signing-keys-come-from">Keys come from your GitHub account</a>.
              </li>
              <li>
                <b>Report back.</b> You get the fingerprint that appears in your proofs. You also get the GitHub
                account the proof names, and the key file it came from.
              </li>
            </ol>
            <p>
              That is the whole machine. Setting up a <em>repository</em> is a separate prompt on the project's
              page in the <a href="/dashboard">dashboard</a>.
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

/**
 * Two tab rows, and which one is drawn says which scope you are in.
 *
 * One flat row listed the organization's sections and a project's queue side by
 * side, so a project page and the organization page had the same header and the
 * same tabs, and nothing on the screen said which of the two you were looking
 * at. The breadcrumb names the place; these name what there is to read there.
 */
export const ORGANIZATION_TABS = [
  ["", "Projects"],
  ["people", "People & teams"],
  ["settings", "Settings"],
] as const;

export const PROJECT_TABS = [
  ["queue", "Queue"],
  ["access", "Access"],
  ["settings", "Settings"],
] as const;

type ProjectPanel = "setup" | "queue" | "access" | "verification";

/** Keep old project links useful while putting each job in its current tab. */
export function projectSection(segment: string): string {
  if (segment === "setup") return "queue";
  if (segment === "overview") return "settings";
  return segment;
}

/** The panels each project tab owns, in the order a reader needs them. */
export function projectPagePanels(segment: string): readonly ProjectPanel[] {
  switch (projectSection(segment)) {
    case "queue":
      return ["setup", "queue"];
    case "access":
      return ["access"];
    case "settings":
      return ["verification"];
    default:
      return [];
  }
}

const ADD_ORG = "__add__";

function OrgSwitcher({ me }: { me: Me }) {
  const current = selectedOrg() ?? me.organization?.github_login ?? "";
  return (
    <select
      className="gp-btn gp-btn--sm gp-btn--quiet"
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

/**
 * The frame every signed-in page is drawn in.
 *
 * The header says where you are as a path, and the tab row says what there is
 * to read in that place. Which tab row appears is the only thing that
 * distinguishes an organization page from a project page, so the two rows are
 * never on screen together.
 */
function DashboardShell({
  me,
  project,
  tabs,
  base,
  active,
  children,
}: {
  me: Me;
  project?: ProjectRow | undefined;
  tabs: ReadonlyArray<readonly [string, string]>;
  base: string;
  active: string;
  children: React.ReactNode;
}) {
  const org = me.organization?.github_login ?? selectedOrg() ?? "";
  return (
    <div className="thwip-shell gp-workspace">
      <header className="thwip-nav">
        <span className="links">
          <a className="thwip-brand" href="/">
            thwip
          </a>
          <span className="thwip-crumb">
            <i aria-hidden="true">/</i>
            <NavLink to="/dashboard">{org}</NavLink>
            {project && (
              <>
                <i aria-hidden="true">/</i>
                <NavLink to={projectPath(project.github_name)}>{repoPart(project.github_name)}</NavLink>
              </>
            )}
          </span>
        </span>
        <span className="links">
          <JumpToProject />
          <OrgSwitcher me={me} />
          <a href="/dashboard/profile" className="gp-panel__meta" title="Your keys and access">
            {me.principal?.github_login ?? me.viewer.githubUserId}
          </a>
          <button
            className="gp-btn gp-btn--sm gp-btn--quiet"
            onClick={() =>
              void api("/api/auth/sign-out", { method: "POST", body: "{}" }).then(() => (window.location.href = "/"))
            }
          >
            Sign out
          </button>
        </span>
      </header>
      <nav className="thwip-tabs" aria-label={project ? "Project" : "Organization"}>
        {tabs.map(([key, label]) => (
          <NavLink key={key} to={key === "" ? base : `${base}/${key}`} className={active === key ? "is-active" : ""}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="gp-workspace__content">
        {!me.organization && (
          <section className="thwip-section">
            <div className="thwip-section__head">Connect your GitHub organization</div>
            <div className="thwip-section__body">
              <p>
                Your GitHub account is not part of a synced thwip organization yet. Install the thwip GitHub App on
                the organization, then select it above. Organization owners can run a recovery sync from Settings.
              </p>
            </div>
          </section>
        )}
        {children}
      </main>
      <SiteFoot />
    </div>
  );
}

function repoPart(githubName: string): string {
  const slash = githubName.indexOf("/");
  return slash === -1 ? githubName : githubName.slice(slash + 1);
}

/**
 * Reach a project by typing its name.
 *
 * An organization with thirty repositories had one way in: read the table until
 * you find the row. The list is already loaded to draw that table, so this
 * costs a datalist and nothing else.
 */
function JumpToProject() {
  const { data } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  const projects = data?.projects ?? [];
  const jump = (value: string) => {
    const match = projects.find((p) => p.github_name === value || repoPart(p.github_name) === value);
    if (match) navigate(projectPath(match.github_name));
  };
  return (
    <>
      <input
        className="thwip-search"
        type="search"
        list="thwip-projects"
        placeholder="jump to a project"
        aria-label="Jump to a project"
        onChange={(e) => jump(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") jump((e.target as HTMLInputElement).value);
        }}
      />
      <datalist id="thwip-projects">
        {projects.map((p) => (
          <option key={p.id} value={p.github_name} />
        ))}
      </datalist>
    </>
  );
}

/**
 * Whether to offer this reader the controls an administrator has.
 *
 * A hint, not the answer. The control plane decides per repository — an owner of
 * the organization can hold no administrator rights on one of its repositories —
 * and refuses with a reason the panel shows. This only decides whether a button
 * is worth putting in front of somebody.
 */
function isOrgAdmin(me: Me): boolean {
  return me.viewer.githubOrgRole === "admin" || me.viewer.githubOrgRole === "owner";
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

interface QueueSummary {
  githubRepositoryId: string;
  waiting: number;
  head: { pullRequestNumber: number; state: string; primaryReason: string | null } | null;
}

/**
 * The one page somebody arrives at, and the one question they arrive with.
 *
 * This was three screens. An overview led with three figures, one of which was
 * a plan name standing in a row of limits, and buried the only actionable thing
 * on it — the repository whose last verification failed — in an eight-row
 * table. Beside it a project list said which repositories existed, and a queue
 * tab stacked a full panel per repository in arbitrary order, so the answer to
 * "which of these needs me" was assembled by reading three places.
 *
 * One table now, ordered by what needs attention, carrying the queue's own head
 * and backlog on each row. The limits keep their place above it because they
 * decide what you may do next, and the plan is set as the word it is rather
 * than as a third ratio.
 */
function OrgHome({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  const summary = useFetch<{
    plan: string;
    limits: { projects: number; users: number };
    enabledProjects: number;
    activatedUsers: number;
    viewerHasSigningKey: boolean;
  }>("/v1/dashboard/summary");
  const queues = useFetch<{ queues: QueueSummary[] }>("/v1/dashboard/queues");
  const metrics = useFetch<ReusedCiMetrics>("/v1/dashboard/metrics");
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

  const queueOf = new Map((queues.data?.queues ?? []).map((q) => [q.githubRepositoryId, q]));
  const rows = data.projects
    .map((project) => describeRow(project, lastVerification(project), queueOf.get(project.github_repository_id)))
    .sort((a, b) => a.rank - b.rank || a.project.github_name.localeCompare(b.project.github_name));

  return (
    <>
      {summary.data && (
        <div className="thwip-limits">
          <Limit label="Enabled projects" used={summary.data.enabledProjects} of={summary.data.limits.projects} />
          <Limit label="Signers" used={summary.data.activatedUsers} of={summary.data.limits.users} />
          <span className="thwip-limit">
            Plan <b>{summary.data.plan}</b>
          </span>
        </div>
      )}
      <DashboardMetrics metrics={metrics.data} error={metrics.error} />
      <section className="thwip-section">
        <div className="thwip-section__head">
          Projects<span>ordered by what needs attention</span>
        </div>
        <div className="thwip-section__body">
          {actionError && <p className="thwip-error">{actionError}</p>}
          {data.projects.length === 0 && (
            <p>
              No repositories imported yet. <NavLink to="/dashboard/settings">Run a full sync from Settings.</NavLink>
            </p>
          )}
          {data.projects.length > 0 && (
            <table className="thwip-table">
              <thead>
                <tr>
                  <th scope="col" className="st">
                    State
                  </th>
                  <th scope="col">Project</th>
                  <th scope="col" className="why">
                    Why
                  </th>
                  <th scope="col">At the head</th>
                  <th scope="col" className="n">
                    Waiting
                  </th>
                  <th scope="col" className="n">
                    Last
                  </th>
                  <th scope="col" className="n">
                    <span className="thwip-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.project.id}>
                    <td className={`st st--${row.tone}`}>{row.state}</td>
                    <td>
                      <NavLink to={projectPath(row.project.github_name)} className="m">
                        {row.project.github_name}
                      </NavLink>
                      <span className="thwip-sub">
                        {row.project.default_branch} · {row.project.collaborators} with access ·{" "}
                        {proofCheckModeText(row.project.proof_check_mode)}
                      </span>
                    </td>
                    <td className="why">{row.why}</td>
                    <td className="q">{row.head}</td>
                    <td className="n num">{row.waiting}</td>
                    <td className="n q w">{row.last}</td>
                    <td className="n">
                      <ConfirmAction
                        label={row.project.enabled === 1 ? "Disable" : "Enable"}
                        title={row.project.enabled === 1 ? "Stop verifying this project?" : "Enable this project?"}
                        consequence={
                          row.project.enabled === 1
                            ? "The App check stops publishing, and the queue stops running for it."
                            : "It consumes plan quota, and enabling it needs repository admin on GitHub."
                        }
                        confirmLabel={row.project.enabled === 1 ? "Disable it" : "Enable it"}
                        busy={busy === row.project.id}
                        onConfirm={() => void act(row.project, row.project.enabled === 1 ? "disable" : "enable")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary.data?.viewerHasSigningKey === false && (
            <p className="thwip-note">
              You hold no signing key. Nothing you push can carry a proof yet.{" "}
              <a href="/dashboard/profile">Set this machine up</a>
            </p>
          )}
          {installUrl && (
            <p className="thwip-note">
              Grant the thwip App access to a repository on GitHub. The repository imports here automatically, and
              then you enable it.{" "}
              <a href={installUrl} target="_blank" rel="noreferrer">
                Add repositories on GitHub
              </a>
            </p>
          )}
        </div>
      </section>
    </>
  );
}

export function DashboardMetrics({ metrics, error }: { metrics: ReusedCiMetrics | null; error: string | null }) {
  return (
    <section className="thwip-section">
      <div className="thwip-section__head">
        Reused CI<span>measured from signed proofs that merged</span>
      </div>
      <div className="thwip-section__body">
        {error !== null ? (
          <p className="thwip-error">Measured results are unavailable: {error}</p>
        ) : metrics === null ? (
          <p className="gp-panel__meta">Loading measured results…</p>
        ) : metrics.status === "empty" ? (
          <p>No merge has reused a measured proof yet.</p>
        ) : (
          <>
            <dl className="thwip-metrics">
              <div>
                <dt>Verified local CI reused</dt>
                <dd>{durationText(metrics.signedWallClockDurationMs)}</dd>
              </div>
              <div>
                <dt>Proof verification overhead</dt>
                <dd>{durationText(metrics.verificationOverheadMs)}</dd>
              </div>
              <div>
                <dt>Merges that reused a proof</dt>
                <dd>{metrics.mergedProofs}</dd>
              </div>
            </dl>
            <p className="thwip-note">
              {metricHistory(metrics)}. These are signed run durations, not developer waiting time or money saved.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** A ratio approaching a ceiling. The bar is the only thing a plan name cannot have. */
function Limit({ label, used, of }: { label: string; used: number; of: number }) {
  const pct = of === 0 ? 0 : Math.min(100, Math.round((used / of) * 100));
  return (
    <span className={used >= of ? "thwip-limit thwip-limit--full" : "thwip-limit"}>
      {label}
      <b>
        {used}/{of}
      </b>
      <i aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </i>
    </span>
  );
}

interface OrgRow {
  project: ProjectRow;
  tone: "ok" | "bad" | "wait" | "off";
  state: string;
  why: string;
  head: string;
  waiting: string;
  last: string;
  /** Lower sorts first: what needs a person leads, what is quiet trails. */
  rank: number;
}

/**
 * One repository as a line somebody can scan.
 *
 * The state carries the answer and the tone, and the why is the sentence under
 * it. Both come from the same vocabulary the project page reads, so a failure
 * is worded identically in both places.
 */
function describeRow(project: ProjectRow, last: LastVerification, queue: QueueSummary | undefined): OrgRow {
  // A disabled project has no lane, so whatever the projection still holds for
  // it is history rather than a queue, and naming a pull request at its head
  // would read as work in progress on a repository thwip has stopped watching.
  const live = project.enabled === 1 ? queue : undefined;
  const waiting = live?.waiting ?? 0;
  const head =
    live?.head == null
      ? project.enabled === 1
        ? "nothing queued"
        : "not enabled"
      : `#${live.head.pullRequestNumber} ${entryStateText(live.head.state).toLowerCase()}`;
  const when = whenText(last.at);
  const row = { project, head, waiting: String(waiting), last: when };

  if (project.enabled !== 1) {
    return { ...row, tone: "off", state: "Disabled", why: "Not verified here.", rank: 5 };
  }
  if (project.activation_state === "awaiting_policy") {
    return { ...row, tone: "wait", state: "Awaiting policy", why: "Enabled, with no policy activated yet.", rank: 2 };
  }
  if (last.outcome === null) {
    return { ...row, tone: "wait", state: "Nothing verified", why: "Waiting for a first proof.", rank: 3 };
  }
  const said = outcome(last.outcome);
  return {
    ...row,
    tone: said.tone,
    state: said.label,
    why: said.tone === "ok" ? `Verified ${when}.` : said.detail,
    rank: said.tone === "bad" ? 0 : said.tone === "wait" ? 1 : 4,
  };
}

function ProofDefaults({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useFetch<{ defaults: Record<string, unknown> | null }>(
    "/v1/dashboard/proof-defaults",
  );
  const [form, setForm] = useState<FormState>({ profile: "fast", required: "" });
  const [text, setText] = useState("");
  const [raw, setRaw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setForm(formOf(data.defaults));
    setText(JSON.stringify(documentOf(formOf(data.defaults), data.defaults), null, 2));
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
  const refusal = formRefusal(form);
  return (
    <Panel
      title="Organization proof defaults"
      meta="repositories inherit these settings; a committed thwip.yaml field overrides them after a protected merge"
    >
      {error && <p className="thwip-error">{error}</p>}
      {raw ? (
        <textarea
          className="thwip-json-field"
          aria-label="Organization proof defaults"
          value={text}
          disabled={!canEdit || saving}
          onChange={(event) => setText(event.target.value)}
          rows={12}
        />
      ) : (
        <>
          <div className="thwip-field">
            <label htmlFor="proof-profile">Profile</label>
            <select
              id="proof-profile"
              value={form.profile}
              disabled={!canEdit || saving}
              onChange={(event) => setForm({ ...form, profile: event.target.value as Profile })}
            >
              {PROFILES.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </div>
          <div className="thwip-field">
            <label htmlFor="proof-required">Required suites</label>
            <input
              id="proof-required"
              value={form.required}
              disabled={!canEdit || saving}
              placeholder="lint, typecheck, test"
              onChange={(event) => setForm({ ...form, required: event.target.value })}
            />
          </div>
          <p className="gp-panel__meta">
            Every suite named here must pass before a proof counts. A repository can add to this in its own
            thwip.yaml. It cannot take one away.
          </p>
          {hasFieldsBeyondTheForm(data?.defaults ?? null) && (
            <p className="gp-panel__meta">
              These defaults also carry settings this form does not show. Saving here keeps them as they are.
            </p>
          )}
        </>
      )}
      {refusal && !raw && <p className="thwip-error">{refusal}</p>}
      {saveError && <p className="thwip-error">{saveError}</p>}
      {canEdit ? (
        <div className="thwip-actions">
          <button
            className="gp-btn gp-btn--sm"
            disabled={saving || (!raw && refusal !== null)}
            onClick={() => {
              if (!raw) {
                void save(documentOf(form, data?.defaults ?? null));
                return;
              }
              try {
                void save(JSON.parse(text) as Record<string, unknown>);
              } catch {
                setSaveError("That is not valid JSON, so nothing was sent.");
              }
            }}
          >
            Save defaults
          </button>
          <button className="gp-btn gp-btn--sm gp-btn--quiet" disabled={saving} onClick={() => setRaw(!raw)}>
            {raw ? "Back to the form" : "Edit as JSON"}
          </button>
          <button className="gp-btn gp-btn--sm gp-btn--quiet" disabled={saving} onClick={() => void save(null)}>
            Clear defaults
          </button>
        </div>
      ) : (
        <p className="gp-panel__meta">Only a GitHub organization owner can change these defaults.</p>
      )}
    </Panel>
  );
}

/**
 * What the check last said about a repository.
 *
 * The project query chooses one newest event from App verifications and
 * observations. Keep the outcome and its time together here so every project
 * view reads that same current state.
 */
interface LastVerification {
  outcome: string | null;
  at: string | null;
}

function lastVerification(project: ProjectRow): LastVerification {
  return { outcome: project.last_outcome, at: project.last_observed_at };
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
      <Panel
        title="Members"
        meta="membership, roles, and permissions are GitHub's own; there are no invitations"
      >
        <table className="thwip-table">
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
                <td>{m.github_org_role === "outside" ? <Chip>outside collaborator</Chip> : (m.github_org_role ?? "member")}</td>
                <td>
                  {m.activated_at ? (
                    <StatusChip tone="ok">Signed in</StatusChip>
                  ) : (
                    <StatusChip tone="off">Never signed in</StatusChip>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Teams">
        {data.teams.length === 0 && <p>No GitHub teams synced.</p>}
        <table className="thwip-table">
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
/**
 * One page per project, and the queue is what it opens on.
 *
 * The first section used to be an overview: four facts and two buttons, with
 * the queue a click away. Those facts are what a project is rather than what it
 * is doing, so they moved into the header strip, where they are on screen for
 * every section, and the page opens on the thing somebody came to read.
 */
function ProjectPage({ githubName, section, me }: { githubName: string; section: string; me: Me }) {
  const { data, error, reload } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
  if (error) return <p className="thwip-error">{error}</p>;
  if (!data) return <p className="gp-panel__meta">Loading…</p>;

  const project = findProjectByGithubName(data.projects, githubName);
  if (!project) {
    return (
      <DashboardShell me={me} tabs={[]} base="/dashboard" active="">
        <section className="thwip-section">
          <div className="thwip-section__head">Unknown project</div>
          <div className="thwip-section__body">
            <p className="thwip-error">
              No project at <code>{githubName}</code>. Check the spelling, or it may have been removed from the
              organization.
            </p>
          </div>
        </section>
      </DashboardShell>
    );
  }

  const active = projectSection(section);
  const panels = projectPagePanels(section);
  return (
    <DashboardShell
      me={me}
      project={project}
      tabs={PROJECT_TABS}
      base={projectPath(project.github_name)}
      active={active}
    >
      <dl className="thwip-facts">
        {projectFacts(project).map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.tone ?? ""}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {panels.includes("setup") && <ProjectSetup project={project} me={me} />}
      {panels.includes("queue") && (
        <QueuePanel
          repositoryId={project.github_repository_id}
          baseRef={`refs/heads/${project.default_branch}`}
          repositoryName={project.github_name}
          canAdminister={isOrgAdmin(me)}
        />
      )}
      {panels.includes("access") && <ProjectAccess projectId={project.id} me={me} />}
      {panels.includes("verification") && <ProjectVerification project={project} reload={reload} />}
    </DashboardShell>
  );
}

interface ProjectFact {
  label: string;
  value: string;
  tone?: "ok" | "bad";
}

/**
 * What this project is, on screen for every section of it.
 *
 * Written as one sentence these broke wherever the line ended, which put the
 * word "App" alone on a row of its own. Each is its own labelled fact, so it
 * can only break between them.
 */
function projectFacts(p: ProjectRow): ProjectFact[] {
  const facts: ProjectFact[] = [{ label: "State", value: activationText(p.activation_state) }];
  if (p.policy_version !== null) {
    facts.push({ label: "Policy", value: `v${p.policy_version} · ${p.policy_profile ?? "unknown profile"}` });
  }
  facts.push({ label: "Default branch", value: p.default_branch });
  facts.push({ label: "App check", value: p.proof_check_mode === "enforced" ? "enforcing" : "observing" });
  if (p.last_outcome !== null) {
    const said = outcome(p.last_outcome);
    facts.push({
      label: "Last verification",
      value: `${said.label} ${whenText(p.last_observed_at)}`,
      ...(said.tone === "ok" || said.tone === "bad" ? { tone: said.tone } : {}),
    });
  }
  return facts;
}

function ProjectVerification({ project, reload }: { project: ProjectRow; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const last = lastVerification(project);
  const setMode = async (mode: "observe" | "enforced") => {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/v1/dashboard/projects/${project.id}/proof-mode`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (action: "enable" | "disable") => {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/v1/dashboard/projects/${project.id}/${action}`, { method: "POST", body: "{}" });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enforced = project.proof_check_mode === "enforced";

  return (
    <>
      <Panel title="Verification" meta="what the queue requires before this repository merges">
        <table className="thwip-table">
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
              <td>{configSourceText(project.config_source)}</td>
            </tr>
            <tr>
              <td>Last verification</td>
              <td>
                <OutcomeText code={last.outcome} at={last.at} />
              </td>
            </tr>
            <tr>
              <td>App-owned check</td>
              <td>
                {enforced
                  ? "Enforcing. A pull request cannot merge until the App verifies a proof on its head commit."
                  : "Observing. It reports what it would have said, and blocks nothing."}
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      <Panel title="Actions" meta="enabling consumes plan quota and needs repository admin on GitHub">
        {actionError && <p className="thwip-error">{actionError}</p>}
        <div className="thwip-actions">
          {project.enabled === 1 ? (
            <ConfirmAction
              label="Disable"
              title="Stop verifying this repository?"
              consequence={
                <>
                  <p>
                    The thwip check stops reporting on <code>{project.github_name}</code>, and stops gating merges
                    if it was enforcing. Its plan slot goes back to the pool.
                  </p>
                  <p>Enabling it again later is one click. The policy history stays either way.</p>
                </>
              }
              confirmLabel="Stop verifying"
              busy={busy}
              onConfirm={() => void act("disable")}
            />
          ) : (
            <button className="gp-btn gp-btn--sm" disabled={busy} onClick={() => void act("enable")}>
              Enable
            </button>
          )}
          {/*
            Enforcement was a plain solid button beside Disable, with no warning
            and nothing said about what it does. It is the moment this project
            starts blocking merges, so it asks first, in the same place, and says
            what changes and how to walk it back.
          */}
          {project.enabled === 1 && !enforced && (
            <ConfirmAction
              label="Enforce App check"
              title={`Let the App block merges on ${project.github_name}?`}
              consequence={
                <>
                  <p>
                    Right now the check observes: it says what it would have decided and lets everything through.
                    Enforcing makes that decision binding. From the next event on, a pull request cannot merge until
                    the thwip App verifies a proof on its head commit against policy v
                    {project.policy_version ?? "?"}.
                  </p>
                  <p>
                    Anything without a valid proof stays unmergeable, including work that is open right now. Only
                    the App may publish this check, so no one can hand-wave it green.
                  </p>
                  <p>You can return to observing from this page at any time.</p>
                </>
              }
              confirmLabel="Enforce it"
              busy={busy}
              onConfirm={() => void setMode("enforced")}
            />
          )}
          {project.enabled === 1 && enforced && (
            <button
              className="gp-btn gp-btn--sm gp-btn--quiet"
              disabled={busy}
              title="The check keeps reporting, but stops blocking merges."
              onClick={() => void setMode("observe")}
            >
              Return to observing
            </button>
          )}
        </div>
      </Panel>
    </>
  );
}

interface BootstrapOutcome {
  kind: "advanced" | "waiting" | "refused";
  step: string;
  detail: string;
  pullRequestNumber?: number;
  manualRulesets?: Array<
    | { operation: "create"; ruleset: Record<string, unknown> }
    | { operation: "update"; rulesetId: number; ruleset: Record<string, unknown> }
  >;
  confirmationRequired?: "queue-enforcement" | "ruleset-bypass-actors";
  expectedBypassActors?: Array<{ ruleset: string; bypassActors: Array<Record<string, unknown>> }>;
}

interface BootstrapBody {
  nextStep?: string | null;
  complete?: boolean;
  enabled?: boolean;
  activationState?: string;
  chainPublic?: boolean;
  outcomes?: BootstrapOutcome[];
  error?: string;
}

/**
 * The bootstrap route answers 200, 202, and 409 with a body worth reading, so
 * this reads the status rather than going through `api`, which throws away
 * everything but an `error` field.
 */
async function bootstrapRequest(
  repositoryId: string,
  method: "GET" | "POST",
  input: {
    includeRepositoryConfig?: boolean;
    chainPublic?: boolean;
    confirmQueueEnforcement?: boolean;
    confirmRulesetBypassActors?: boolean;
  } = {},
): Promise<{ status: number; body: BootstrapBody }> {
  const res = await fetch(withOrg(`/v1/queue/${repositoryId}/bootstrap`), {
    method,
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as BootstrapBody;
  return { status: res.status, body };
}

/** The number GitHub gave the setup pull request. */
function setupPullNumber(body: BootstrapBody): number | null {
  for (const outcome of body.outcomes ?? []) {
    if (outcome.kind === "waiting" && outcome.pullRequestNumber !== undefined) {
      return outcome.pullRequestNumber;
    }
  }
  return null;
}

/** What a run stopped on, in the route's own words. */
function stoppedOn(body: BootstrapBody): string | null {
  const last = (body.outcomes ?? []).at(-1);
  return last === undefined ? null : last.detail;
}

function rulesetCommand(
  repository: string,
  change: NonNullable<BootstrapOutcome["manualRulesets"]>[number],
): string {
  const path =
    change.operation === "create"
      ? `repos/${repository}/rulesets`
      : `repos/${repository}/rulesets/${change.rulesetId}`;
  return [
    `gh api --method ${change.operation === "create" ? "POST" : "PUT"} ${path} --input - <<'JSON'`,
    JSON.stringify(change.ruleset, null, 2),
    "JSON",
  ].join("\n");
}

type EnrolmentPhase = "idle" | "running" | "waiting" | "enrolled" | "failed";

/** What a completed setup actually does at its final activation state. */
export function completedQueueActivationText(activationState: string | undefined): string {
  if (activationState === "enforced") {
    return "It owns normal branch updates and requires the App proof and turn checks.";
  }
  return "It reports what it would do and blocks nothing until you enforce it.";
}

/**
 * Enrolling a repository, as a control.
 *
 * This was a hand-written D1 row, two workflows copied in, and a ruleset built
 * with `gh api` in the one order GitHub accepts. The run stops in the middle
 * for the setup pull request, which a person merges, so the button comes back
 * to continue rather than pretending the wait is progress.
 */
function QueueEnrolment({ project, canAdminister }: { project: ProjectRow; canAdminister: boolean }) {
  const repositoryId = project.github_repository_id;
  const [phase, setPhase] = useState<EnrolmentPhase>("idle");
  const [body, setBody] = useState<BootstrapBody>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pull, setPull] = useState<number | null>(null);
  const [includeRepositoryConfig, setIncludeRepositoryConfig] = useState(false);
  const [chainPublic, setChainPublic] = useState(false);
  const [chainChoiceExplicit, setChainChoiceExplicit] = useState(false);
  const [savingChainVisibility, setSavingChainVisibility] = useState(false);
  const [confirmedQueueEnforcement, setConfirmedQueueEnforcement] = useState(false);
  const [confirmedBypassActors, setConfirmedBypassActors] = useState(false);

  // What setup already got to, so a reader who comes back to this page sees
  // where it stands rather than a button that implies nothing has happened.
  useEffect(() => {
    if (!canAdminister) return;
    let live = true;
    void bootstrapRequest(repositoryId, "GET").then(({ status, body: read }) => {
      if (!live || status !== 200) return;
      setBody(read);
      setChainPublic(read.chainPublic === true);
      setChainChoiceExplicit(false);
      setPhase(read.complete === true ? "enrolled" : "waiting");
    });
    return () => {
      live = false;
    };
  }, [repositoryId, canAdminister]);

  // Nothing advances while the setup pull request waits, so polling only keeps
  // the shown position honest: another administrator may have continued it.
  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = setInterval(() => {
      void bootstrapRequest(repositoryId, "GET").then(({ status, body: read }) => {
        if (status !== 200) return;
        setBody((prev) => ({ ...prev, ...read }));
        if (read.complete === true) setPhase("enrolled");
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, repositoryId]);

  const start = async () => {
    setPhase("running");
    setFailure(null);
    try {
      const { status, body: answered } = await bootstrapRequest(repositoryId, "POST", {
        ...(includeRepositoryConfig ? { includeRepositoryConfig: true } : {}),
        ...(chainChoiceExplicit ? { chainPublic } : {}),
        ...(confirmedQueueEnforcement ? { confirmQueueEnforcement: true } : {}),
        ...(confirmedBypassActors ? { confirmRulesetBypassActors: true } : {}),
      });
      setConfirmedQueueEnforcement(false);
      setConfirmedBypassActors(false);
      setBody(answered);
      setChainPublic(answered.chainPublic === true);
      setChainChoiceExplicit(false);
      if (status === 200) {
        setPhase("enrolled");
        return;
      }
      if (status === 202) {
        setPull(setupPullNumber(answered) ?? pull);
        setPhase("waiting");
        return;
      }
      setPhase("failed");
      setFailure(
        answered.error ??
          stoppedOn(answered) ??
          (status === 409 ? "Setup refused a change that would take a control away." : `${status}`),
      );
    } catch (e) {
      setConfirmedQueueEnforcement(false);
      setConfirmedBypassActors(false);
      setPhase("failed");
      setFailure((e as Error).message);
    }
  };

  const saveChainVisibility = async () => {
    setSavingChainVisibility(true);
    setFailure(null);
    try {
      const { status, body: answered } = await bootstrapRequest(repositoryId, "POST", { chainPublic });
      setBody(answered);
      setChainPublic(answered.chainPublic === true);
      setChainChoiceExplicit(false);
      if (status !== 200) {
        setFailure(answered.error ?? stoppedOn(answered) ?? `Could not save chain visibility (${status}).`);
      }
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setSavingChainVisibility(false);
    }
  };

  if (!canAdminister) {
    return (
      <Panel title="Thwip Queue" meta="one request, made by an organization administrator">
        <p>
          Setting up the queue needs the admin or owner role in this organization on GitHub. Ask someone who has
          that role to open this tab.
        </p>
      </Panel>
    );
  }

  const waiting = body.outcomes?.at(-1);
  const manualRulesets = waiting?.kind === "waiting" ? (waiting.manualRulesets ?? []) : [];
  const needsQueueEnforcementConfirmation =
    waiting?.kind === "waiting" && waiting.confirmationRequired === "queue-enforcement";
  const needsBypassConfirmation =
    waiting?.kind === "waiting" && waiting.confirmationRequired === "ruleset-bypass-actors";

  return (
    <Panel title="Thwip Queue" meta="merges one pull request at a time, with a signed record of each merge">
      <p>
        Setup opens a pull request on <code>{project.github_name}</code> carrying the two queue workflows. It
        inherits organization policy by default. A repository-specific <code>thwip.yaml</code> is added only when
        you choose that override below. Merge that pull request under the controls this repository already has, then
        continue. The queue observes a real pull request before setup offers enforcement. The App receives Contents
        and Workflows write, so the one queue path can merge reviewed source and CI changes. It never receives
        repository Administration permission.
      </p>
      {failure && <p className="thwip-error">{failure}</p>}
      {phase === "idle" && (
        <label>
          <input
            type="checkbox"
            checked={includeRepositoryConfig}
            onChange={(event) => setIncludeRepositoryConfig(event.target.checked)}
          />{" "}
          Add a repository-specific Node.js policy override instead of inheriting organization defaults.
        </label>
      )}
      <div>
        <label>
          <input
            type="checkbox"
            checked={chainPublic}
            disabled={phase === "running" || savingChainVisibility}
            onChange={(event) => {
              setChainPublic(event.target.checked);
              setChainChoiceExplicit(true);
            }}
          />{" "}
          Let anyone read and verify this repository's signed queue chain without signing in.
        </label>
        <p className="gp-panel__meta">
          Public records include pull request numbers, commit and tree identifiers, actor GitHub IDs, timestamps, and
          free-text override reasons. Leave this off for a private repository; authorized organization members can
          still read its chain. The default is private.
        </p>
        {phase === "enrolled" && (
          <div className="thwip-actions">
            <button
              className="gp-btn gp-btn--sm gp-btn--quiet"
              disabled={savingChainVisibility || chainPublic === body.chainPublic}
              onClick={() => void saveChainVisibility()}
            >
              {savingChainVisibility ? "Saving…" : "Save chain visibility"}
            </button>
            <StatusChip tone={body.chainPublic === true ? "ok" : "off"}>
              {body.chainPublic === true ? "Public chain" : "Private chain"}
            </StatusChip>
          </div>
        )}
      </div>
      {phase === "waiting" && (
        <>
          <p>
            {pull !== null && (
              <>
                Setup pull request{" "}
                <a href={`https://github.com/${project.github_name}/pull/${pull}`} target="_blank" rel="noreferrer">
                  #{pull}
                </a>
                .{" "}
              </>
            )}
            {stoppedOn(body) ?? `Next: ${body.nextStep ?? "unknown"}.`}
          </p>
          {manualRulesets.map((change) => (
            <div
              key={`${change.operation}-${change.operation === "update" ? String(change.rulesetId) : "new"}-${String(change.ruleset.name)}`}
            >
              <p>
                Run this while authenticated to GitHub as a repository administrator. Apply the commands in the order
                shown, then continue setup.
              </p>
              <pre className="thwip-code-block">{rulesetCommand(project.github_name, change)}</pre>
            </div>
          ))}
          {needsBypassConfirmation && (
            <>
              <p>GitHub hides these fields from the read-only App. Compare the exact expected lists:</p>
              <pre className="thwip-code-block">{JSON.stringify(waiting.expectedBypassActors ?? [], null, 2)}</pre>
              <label>
                <input
                  type="checkbox"
                  checked={confirmedBypassActors}
                  onChange={(event) => setConfirmedBypassActors(event.target.checked)}
                />{" "}
                I verified in GitHub that every bypass-actor list exactly matches the expected lists above.
              </label>
            </>
          )}
          {needsQueueEnforcementConfirmation && (
            <label>
              <input
                type="checkbox"
                checked={confirmedQueueEnforcement}
                onChange={(event) => setConfirmedQueueEnforcement(event.target.checked)}
              />{" "}
              I validated the observe-mode proof and queue checks on a real pull request. Begin queue enforcement.
            </label>
          )}
        </>
      )}
      {phase === "enrolled" && (
        <p>
          <StatusChip tone="ok">Enrolled</StatusChip> The queue is {body.activationState ?? "observing"} on{" "}
          <code>{project.default_branch}</code>. {completedQueueActivationText(body.activationState)}
        </p>
      )}
      {phase !== "enrolled" && (
        <div className="thwip-actions">
          <button
            className="gp-btn gp-btn--sm"
            disabled={
              phase === "running" ||
              (needsQueueEnforcementConfirmation && !confirmedQueueEnforcement) ||
              (needsBypassConfirmation && !confirmedBypassActors)
            }
            onClick={() => void start()}
          >
            {phase === "running"
              ? "Setting up…"
              : needsQueueEnforcementConfirmation
                ? "Begin enforcement"
                : phase === "waiting"
                  ? "Continue setup"
                  : "Set up the queue"}
          </button>
        </div>
      )}
      <p className="gp-panel__meta">
        To drive this from a coding agent instead, run <code>thwip queue setup</code> for the prompt.
      </p>
    </Panel>
  );
}

function ProjectSetup({ project: p, me }: { project: ProjectRow; me: Me }) {
  const [copied, setCopied] = useState(false);
  const prompt = buildSetupPrompt(p);
  return (
    <>
      <Panel
        title={`Set up ${p.github_name}`}
        meta="paste into your coding agent, in a checkout of this repository"
      >
        <p>
          The agent installs the CLI and signs you in. It resolves organization defaults, then proposes only the
          repository overrides this project needs. It proves the App-owned check in observe mode and guides the
          staged ruleset activation. Re-running it is safe.
        </p>
        <button
          className="gp-btn gp-btn--sm"
          onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy prompt"}
        </button>
        <pre className="thwip-code-block">{prompt}</pre>
      </Panel>
      <QueueEnrolment project={p} canAdminister={isOrgAdmin(me)} />
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
      <Panel title={`Access · ${data.project.github_name}`} meta="who may sign a proof for this repository">
        <table className="thwip-table">
          <thead>
            <tr>
              <th>Member</th>
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
                <td>{g.permission}</td>
                <td>
                  {g.active ? (
                    <StatusChip tone="ok">Current</StatusChip>
                  ) : (
                    <StatusChip tone="off">Removed on GitHub</StatusChip>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {data.teams.length > 0 && (
        <Panel title="Teams with access">
          <table className="thwip-table">
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

  const [denying, setDenying] = useState<string | null>(null);
  const [denyError, setDenyError] = useState<string | null>(null);
  // A failing request used to reject an unawaited promise, so a denial that the
  // control plane refused left the row exactly as it was and said nothing.
  const deny = async (keyId: string) => {
    setDenying(keyId);
    setDenyError(null);
    try {
      await api(`/v1/dashboard/devices/${keyId}/revoke`, { method: "POST", body: "{}" });
      reload();
    } catch (e) {
      setDenyError((e as Error).message);
    } finally {
      setDenying(null);
    }
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
          <table className="thwip-table">
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
                      <code className="gp-mono">{k.fingerprint}</code>
                    </td>
                    <td>
                      {cached?.revoked_at ? (
                        <StatusChip tone="bad">Denied here</StatusChip>
                      ) : (
                        <StatusChip tone="ok">Live on GitHub</StatusChip>
                      )}
                    </td>
                    <td>
                      {cached && !cached.revoked_at && (
                        <ConfirmAction
                          label="Deny in this org"
                          title="Stop accepting proofs signed by this key?"
                          consequence={
                            <>
                              <p>
                                Every proof this key has signed stops counting here, including proofs already sitting
                                on open pull requests. Those pull requests go back to unverified until something signs
                                them again.
                              </p>
                              <p>
                                The key stays on your GitHub account and keeps working everywhere else. Nothing in the
                                dashboard can undo this.
                              </p>
                            </>
                          }
                          confirmLabel="Deny it"
                          busy={denying === cached.key_id}
                          onConfirm={() => void deny(cached.key_id)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {denyError && <p className="thwip-error">{denyError}</p>}
        <p className="gp-panel__meta">
          Add or remove keys in{" "}
          <a href="https://github.com/settings/keys" target="_blank" rel="noreferrer">
            your GitHub settings
          </a>
          . Denying here blocks a key in this organization without touching your GitHub account.
        </p>
      </Panel>

      <Panel title="Add a device" meta="paste into the coding agent on that machine">
        <p>
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
          <button className="gp-btn gp-btn--sm gp-btn--quiet" onClick={() => setShowPrompt((v) => !v)}>
            {showPrompt ? "Hide" : "Show"} prompt
          </button>
        </div>
        {showPrompt && <pre className="thwip-code-block">{prompt}</pre>}
      </Panel>

      {data.seen.some((k) => k.source !== "github") && (
        <Panel title="Superseded" meta="keys from before GitHub became the authority; kept so old proofs stay explainable">
          <table className="thwip-table">
            <tbody>
              {data.seen
                .filter((k) => k.source !== "github")
                .map((k) => (
                  <tr key={k.key_id}>
                    <td>{k.device_label}</td>
                    <td>
                      <code className="gp-mono">{k.fingerprint}</code>
                    </td>
                    <td>
                      <StatusChip tone="off">Cannot sign</StatusChip>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Your access" meta="from GitHub; this is what your proofs may cover">
        <table className="thwip-table">
          <tbody>
            {data.access.map((g, i) => (
              <tr key={i}>
                <td>
                  <a href={`https://github.com/${g.github_name}`} target="_blank" rel="noreferrer">
                    <code>{g.github_name}</code>
                  </a>
                </td>
                <td>{g.permission}</td>
                <td>
                  {g.active ? (
                    <StatusChip tone="ok">Current</StatusChip>
                  ) : (
                    <StatusChip tone="off">Removed on GitHub</StatusChip>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
function OrgSettings({ me }: { me: Me }) {
  return (
    <>
      <ProofDefaults canEdit={me.viewer.githubOrgRole === "owner"} />
      <GitHubSync canSync={me.viewer.githubOrgRole === "owner"} />
      <Billing />
    </>
  );
}

export function GitHubSync({ canSync }: { canSync: boolean }) {
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sync = async () => {
    setSyncing(true);
    setNote(null);
    try {
      const res = await api<{ synced: Record<string, number> }>("/v1/dashboard/sync", { method: "POST", body: "{}" });
      setNote(`Synced: ${JSON.stringify(res.synced)}`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };
  return (
    <Panel title="GitHub sync" meta="recovery control; webhooks normally keep project data current">
      {canSync ? (
        <button className="gp-btn gp-btn--sm" disabled={syncing} onClick={() => void sync()}>
          {syncing ? "Syncing…" : "Run full sync"}
        </button>
      ) : (
        <p className="gp-panel__meta">Only GitHub organization owners can run a full sync.</p>
      )}
      {note && (
        <p className="gp-panel__meta">
          <code>{note}</code>
        </p>
      )}
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
    <Panel title="Billing">
      <dl className="thwip-pairs">
        <div>
          <dt>Plan</dt>
          <dd className="big">{data.plan}</dd>
        </div>
        <div>
          <dt>Project limit</dt>
          <dd className="big">{data.limits.projects}</dd>
        </div>
        <div>
          <dt>User limit</dt>
          <dd className="big">{data.limits.users}</dd>
        </div>
        {data.subscription && (
          <div>
            <dt>Subscription</dt>
            <dd className="big">{data.subscription.status}</dd>
          </div>
        )}
      </dl>
      {note && <p className="thwip-error">{note}</p>}
      {data.isOwner ? (
        data.plan === "free" ? (
          <div className="thwip-actions">
            <button className="gp-btn" disabled={working} onClick={() => void upgrade(false)}>
              Upgrade to Pro, $5/month
            </button>
            <button className="gp-btn gp-btn--quiet" disabled={working} onClick={() => void upgrade(true)}>
              Annual, $50/year
            </button>
          </div>
        ) : (
          <div className="thwip-actions">
            <button className="gp-btn" disabled={working} onClick={() => void portal()}>
              Manage billing
            </button>
          </div>
        )
      ) : (
        <p className="gp-panel__meta">Only GitHub organization owners can change billing.</p>
      )}
    </Panel>
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

/* ---------- router ---------- */

/**
 * The frame every dashboard state is drawn inside.
 *
 * A state that returns its own markup instead lands in the top-left corner of
 * an empty page with no header and no width. That happened to the loading
 * state, was fixed there, and went on happening to the signed-out one, which
 * is the state a visitor arriving from the homepage sees first. One frame, so
 * the next state added cannot repeat it.
 */
function DashboardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="thwip-shell gp-workspace">
      <nav className="thwip-nav" aria-label="Dashboard">
        <a className="thwip-brand" href="/">
          thwip<small>DASHBOARD</small>
        </a>
      </nav>
      <main className="gp-workspace__content">{children}</main>
      <SiteFoot />
    </div>
  );
}

export function SignedOutDashboard() {
  return (
    <DashboardFrame>
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
    </DashboardFrame>
  );
}

/**
 * Where a path that no longer exists goes.
 *
 * Overview, the organization-wide queue, and policy history were folded into
 * the project list. Billing and the full-sync recovery control live in
 * Settings. A reader with an old bookmark lands on the page that now answers
 * what they went there for rather than on an empty tab.
 */
const MOVED: Record<string, string> = {
  overview: "",
  projects: "",
  queue: "",
  policies: "",
  billing: "settings",
  operations: "settings",
};

export function organizationSection(segment: string | undefined): string {
  const key = segment ?? "";
  return MOVED[key] ?? key;
}

export function App() {
  const me = useMe();
  const path = usePath();
  const projectMatch = parseProjectPath(path);
  const dashMatch = /^\/dashboard(?:\/([a-z]+))?/.exec(path);

  if (path.startsWith("/device")) return <DevicePage me={me} />;
  if (path.startsWith("/faq")) return <FaqPage me={me} />;
  if (path.startsWith("/install")) return <InstallPage me={me} />;
  if (dashMatch) {
    if (me === undefined) {
      return (
        <DashboardFrame>
          <p className="gp-panel__meta thwip-loading">Loading your organization…</p>
        </DashboardFrame>
      );
    }
    if (me === null) return <SignedOutDashboard />;

    if (projectMatch) {
      return (
        <ProjectPage
          githubName={projectMatch.githubName}
          section={projectMatch.section ?? "queue"}
          me={me}
        />
      );
    }
    return (
      <DashboardShell
        me={me}
        tabs={ORGANIZATION_TABS}
        base="/dashboard"
        active={organizationSection(dashMatch[1])}
      >
        {organizationSection(dashMatch[1]) === "" && <OrgHome me={me} />}
        {organizationSection(dashMatch[1]) === "people" && <People me={me} />}
        {organizationSection(dashMatch[1]) === "settings" && <OrgSettings me={me} />}
        {organizationSection(dashMatch[1]) === "profile" && <Profile me={me} />}
      </DashboardShell>
    );
  }
  return <Home me={me} signIn={() => void signInWithGitHub("/dashboard")} />;
}
