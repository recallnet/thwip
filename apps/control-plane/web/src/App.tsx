import React, { useCallback, useEffect, useMemo, useState } from "react";

/* ---------- shared API helpers ---------- */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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
  const res = await api<{ url?: string; redirect?: boolean }>("/api/auth/sign-in/social", {
    method: "POST",
    body: JSON.stringify({ provider: "github", callbackURL }),
  });
  if (res.url) window.location.href = res.url;
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

/* ---------- marketing site ---------- */

const RECEIPT_TRAILER =
  "thwip-Receipt: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5Rdi4uLiJ9";

function Marketing({ me }: { me: Me | null | undefined }) {
  return (
    <div className="shell">
      <header className="nav">
        <a className="brand" href="/">
          thwip<small>CI RECEIPTS</small>
        </a>
        <nav className="nav-links">
          <a href="#how">How it works</a>
          <a href="#assurance">Assurance</a>
          <a href="#pricing">Pricing</a>
          {me ? (
            <a className="btn small" href="/dashboard">
              Dashboard
            </a>
          ) : (
            <button className="btn small" onClick={() => void signInWithGitHub("/dashboard")}>
              Sign in with GitHub
            </button>
          )}
        </nav>
      </header>

      <section className="hero" style={{ borderTop: "none" }}>
        <div>
          <h1>
            CI ran. <em>Prove it</em> — in the commit itself.
          </h1>
          <p className="sub">
            Your agents already ran lint, typecheck, and tests locally. thwip freezes the exact Git tree, signs a
            compact receipt, and a protected GitHub check verifies it in seconds. No re-running CI in the cloud, no
            taking anyone's word for it.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => void signInWithGitHub("/dashboard")}>
              Install on your org
            </button>
            <a className="btn ghost" href="#how">
              Read the protocol
            </a>
          </div>
          <p className="fine">DSSE · in-toto Statement v1 · OpenSSH signatures · GitHub merge queue native</p>
        </div>

        <div className="receipt" aria-label="Example signed CI receipt inside a git commit message">
          <span className="stamp">VERIFIED</span>
          <div className="dim">$ git log -1 --format=%B</div>
          <hr className="rule" />
          <div>feat: parse lease context into verifier</div>
          <br />
          <div className="trailer">{RECEIPT_TRAILER.slice(0, 120)}…</div>
          <hr className="rule" />
          <div className="dim"># protected check · repository 1315419165</div>
          <div>
            tree <span className="dim">9223b1ca…</span> &nbsp;suites{" "}
            <span className="verdict">lint ✓ typecheck ✓ test ✓</span>
          </div>
          <div>
            signer <span className="dim">key_67f1c7… (ssh-ed25519)</span>
          </div>
          <div>
            verdict <span className="verdict">PASS</span>
            <span className="dim"> · 4.1s · zero reruns</span>
          </div>
        </div>
      </section>

      <section id="how">
        <div className="eyebrow">The loop</div>
        <h2>Execution stays local. Trust stays in GitHub.</h2>
        <p className="lede">
          thwip is a control plane, not a CI compute platform. The work happens where your warm cache already is; the
          enforcement happens where your merges already are.
        </p>
        <div className="steps">
          <div className="step">
            <div className="k">thwip run</div>
            <h3>Run the approved pipeline locally</h3>
            <p>
              The CLI refuses a dirty tree, freezes the exact Git subject, and runs the policy-approved suites. If the
              tree changes mid-run, no receipt.
            </p>
          </div>
          <div className="step">
            <div className="k">thwip-Receipt: v1.…</div>
            <h3>The commit carries the evidence</h3>
            <p>
              One signed trailer binds repository, tree, ancestry, base, policy, pipeline digest, and suite results.
              Copy it to different code and it fails closed.
            </p>
          </div>
          <div className="step">
            <div className="k">merge_group ✓</div>
            <h3>GitHub verifies and merges</h3>
            <p>
              A ruleset-protected check fetches one signed fact bundle, verifies the receipt against the exact head
              commit, and the merge queue does the rest. <code>PASS</code> in seconds.
            </p>
          </div>
        </div>
      </section>

      <section id="assurance">
        <div className="eyebrow">Honest security</div>
        <h2>Reason codes, not vibes.</h2>
        <p className="lede">
          Every verification ends in a stable outcome code. A receipt from a revoked key, a removed collaborator, an
          old policy, or someone else's tree is rejected — deterministically.
        </p>
        <table className="plain">
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Receipt copied onto different code</td>
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
              <td>The exact tree, the exact policy, a current signer</td>
              <td className="ok">PASS</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="pricing">
        <div className="eyebrow">Pricing</div>
        <h2>Same security on every plan. Pay for scale.</h2>
        <div className="pricing">
          <div className="plan">
            <div className="name">Free</div>
            <div className="price">$0</div>
            <div className="cadence">forever</div>
            <ul>
              <li>3 active projects</li>
              <li>5 active signers</li>
              <li>All security profiles</li>
              <li>Merge-queue verification</li>
            </ul>
          </div>
          <div className="plan pro">
            <div className="name">Pro</div>
            <div className="price">$5</div>
            <div className="cadence">per month, or $50/year</div>
            <ul>
              <li>15 active projects</li>
              <li>25 active signers</li>
              <li>All security profiles</li>
              <li>Priority support</li>
            </ul>
          </div>
        </div>
      </section>

      <footer>
        <span>thwip — Git-native CI receipts for agent-run pipelines.</span>
        <span className="code">urn:thwip:attestation:ci-run:v1</span>
      </footer>
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

function Dashboard({ me, tab }: { me: Me; tab: string }) {
  const org = me.organization;
  return (
    <div className="shell">
      <header className="nav">
        <a className="brand" href="/">
          thwip<small>DASHBOARD</small>
        </a>
        <nav className="nav-links">
          {org && (
            <span className="pill on">
              {org.github_login} · {org.plan}
            </span>
          )}
          <span className="muted">{me.principal?.github_login ?? me.viewer.githubUserId}</span>
          <button
            className="btn ghost small"
            onClick={() =>
              void api("/api/auth/sign-out", { method: "POST", body: "{}" }).then(() => (window.location.href = "/"))
            }
          >
            Sign out
          </button>
        </nav>
      </header>
      <div className="dash">
        <nav aria-label="Dashboard sections">
          {TABS.map(([key, label]) => (
            <a key={key} href={`/dashboard/${key}`} className={tab === key ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <main>
          {!org && (
            <div className="panel">
              <h3>Connect your GitHub organization</h3>
              <p className="muted">
                Your GitHub account isn't part of a synced thwip organization yet. Install the thwip GitHub App on your
                organization, then run a sync from Operations.
              </p>
            </div>
          )}
          {tab === "overview" && <Overview />}
          {tab === "projects" && <Projects me={me} />}
          {tab === "people" && <People />}
          {tab === "devices" && <Devices me={me} />}
          {tab === "policies" && <Policies />}
          {tab === "billing" && <Billing me={me} />}
          {tab === "operations" && <Operations me={me} />}
        </main>
      </div>
    </div>
  );
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
  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  return (
    <>
      <div className="panel">
        <h3>Organization at a glance</h3>
        <div className="statrow">
          <div className="stat">
            <div className="v">
              {data.enabledProjects}/{data.limits.projects}
            </div>
            <div className="l">enabled projects</div>
          </div>
          <div className="stat">
            <div className="v">
              {data.activatedUsers}/{data.limits.users}
            </div>
            <div className="l">active users</div>
          </div>
          <div className="stat">
            <div className="v">{data.members}</div>
            <div className="l">github members</div>
          </div>
          <div className="stat">
            <div className="v">{data.teams}</div>
            <div className="l">github teams</div>
          </div>
          <div className="stat">
            <div className="v">{data.activeKeys}</div>
            <div className="l">signing keys</div>
          </div>
          <div className="stat">
            <div className="v">{data.plan}</div>
            <div className="l">plan</div>
          </div>
        </div>
      </div>
      <div className="panel">
        <h3>Ship something</h3>
        <p className="muted code" style={{ fontSize: "0.85rem" }}>
          git checkout -b change · edit · commit · <b>thwip run</b> · git push · gh pr create — the merge queue does
          the rest once the receipt verifies.
        </p>
      </div>
    </>
  );
}

interface ProjectRow {
  id: string;
  github_repository_id: string;
  github_name: string;
  default_branch: string;
  enabled: number;
  security_profile: string;
  active_policy_digest: string | null;
  collaborators: number;
  last_outcome: string | null;
  last_observed_at: string | null;
}

function Projects({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{ projects: ProjectRow[] }>("/v1/dashboard/projects");
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
  const setProfile = async (p: ProjectRow, profile: string) => {
    setBusy(p.id);
    try {
      await api(`/v1/dashboard/projects/${p.id}/profile`, { method: "POST", body: JSON.stringify({ profile }) });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  return (
    <div className="panel">
      <h3>Projects</h3>
      <p className="muted" style={{ marginBottom: 12 }}>
        Enabling a project consumes plan quota. Enable/disable requires repository admin on GitHub.
      </p>
      {actionError && <p className="error-note">{actionError}</p>}
      {data.projects.length === 0 && <p className="empty">No repositories imported yet — run a sync from Operations.</p>}
      <table className="plain">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Status</th>
            <th>Profile</th>
            <th>Policy</th>
            <th>Last verification</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.projects.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="code">{p.github_name}</span>
                <div className="muted" style={{ fontSize: "0.78rem" }}>
                  {p.collaborators} collaborators · {p.default_branch}
                </div>
              </td>
              <td>{p.enabled ? <span className="pill on">enabled</span> : <span className="pill">imported</span>}</td>
              <td>
                <select
                  value={p.security_profile}
                  disabled={busy === p.id}
                  onChange={(e) => void setProfile(p, e.target.value)}
                  aria-label={`Security profile for ${p.github_name}`}
                >
                  <option value="fast">fast</option>
                  <option value="fresh">fresh</option>
                  <option value="audited">audited</option>
                  <option value="remote">remote</option>
                </select>
              </td>
              <td className="code">{p.active_policy_digest ? `${p.active_policy_digest.slice(7, 19)}…` : "—"}</td>
              <td>
                {p.last_outcome ? (
                  <span className={p.last_outcome === "PASS" ? "ok" : "bad"}>{p.last_outcome}</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {p.enabled ? (
                  <button className="btn ghost small" disabled={busy === p.id} onClick={() => void act(p, "disable")}>
                    Disable
                  </button>
                ) : (
                  <button className="btn small" disabled={busy === p.id} onClick={() => void act(p, "enable")}>
                    Enable
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function People() {
  const { data, error } = useFetch<{
    members: Array<{
      github_user_id: string;
      github_login: string;
      avatar_url: string | null;
      github_org_role: string | null;
      activated_at: string | null;
      active_keys: number;
    }>;
    teams: Array<{ team_id: string; slug: string; name: string; members: number; repos: number }>;
    teamMembers: Array<{ team_id: string; github_user_id: string; github_login: string | null }>;
    grants: Array<{ github_name: string; github_login: string; permission: string; active: number }>;
  }>("/v1/dashboard/people");
  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  return (
    <>
      <div className="panel">
        <h3>Members</h3>
        <p className="muted" style={{ marginBottom: 12 }}>
          Imported from GitHub. Roles and permissions here are GitHub's — thwip never invents its own.
        </p>
        <table className="plain">
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
                <td className="code">{m.github_login}</td>
                <td>{m.github_org_role ?? "member"}</td>
                <td>{m.activated_at ? <span className="pill on">active</span> : <span className="pill">shadow</span>}</td>
                <td>{m.active_keys}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Teams</h3>
        {data.teams.length === 0 && <p className="empty">No GitHub teams synced.</p>}
        {data.teams.map((t) => (
          <div key={t.team_id} style={{ marginBottom: 10 }}>
            <span className="code">@{t.slug}</span>{" "}
            <span className="muted">
              — {t.members} members, {t.repos} repos:{" "}
              {data.teamMembers
                .filter((tm) => tm.team_id === t.team_id)
                .map((tm) => tm.github_login ?? tm.github_user_id)
                .join(", ")}
            </span>
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>Effective repository permissions</h3>
        <table className="plain">
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
                <td className="code">{g.github_name}</td>
                <td className="code">{g.github_login}</td>
                <td>{g.permission}</td>
                <td>{g.active ? <span className="pill on">current</span> : <span className="pill off">removed</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  const canRevoke = (d: { github_user_id: string }) =>
    d.github_user_id === me.viewer.githubUserId || me.viewer.githubOrgRole === "owner";
  return (
    <div className="panel">
      <h3>Signing devices</h3>
      <p className="muted" style={{ marginBottom: 12 }}>
        Enroll a new device with <span className="code">thwip login</span> then{" "}
        <span className="code">thwip keys enroll</span>. Revocation takes effect on the next verification.
      </p>
      <table className="plain">
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
              <td className="code">{d.github_login ?? d.github_user_id}</td>
              <td className="code" style={{ fontSize: "0.72rem" }}>
                {d.algorithm} · {d.fingerprint.slice(0, 24)}…
              </td>
              <td>{d.revoked_at ? <span className="pill off">revoked</span> : <span className="pill on">active</span>}</td>
              <td>
                {!d.revoked_at && canRevoke(d) && (
                  <button className="btn danger small" onClick={() => void revoke(d.key_id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  return (
    <div className="panel">
      <h3>Policy history</h3>
      <p className="muted" style={{ marginBottom: 12 }}>
        Policies are immutable, content-addressed bundles. Only the active digest can satisfy a required check; a PR
        can never approve its own policy change.
      </p>
      <table className="plain">
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
              <td className="code">{p.github_name}</td>
              <td>v{p.version}</td>
              <td className="code">{p.digest.slice(7, 23)}…</td>
              <td>
                <span className={`pill ${p.status === "active" ? "on" : ""}`}>{p.status}</span>
              </td>
              <td className="muted">{p.activated_at?.slice(0, 10) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Billing({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{
    plan: string;
    limits: { projects: number; users: number };
    betterAuthOrgId: string | null;
    subscription: { plan: string; status: string; periodEnd: string | null; cancelAtPeriodEnd: number | null } | null;
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
      const res = await api<{ url?: string; redirect?: boolean }>("/api/auth/subscription/upgrade", {
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

  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  return (
    <div className="panel">
      <h3>Billing</h3>
      <div className="statrow" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="v">{data.plan}</div>
          <div className="l">plan</div>
        </div>
        <div className="stat">
          <div className="v">{data.limits.projects}</div>
          <div className="l">project limit</div>
        </div>
        <div className="stat">
          <div className="v">{data.limits.users}</div>
          <div className="l">user limit</div>
        </div>
        {data.subscription && (
          <div className="stat">
            <div className="v">{data.subscription.status}</div>
            <div className="l">subscription</div>
          </div>
        )}
      </div>
      {note && <p className="error-note">{note}</p>}
      {data.isOwner ? (
        data.plan === "free" ? (
          <div className="actions" style={{ display: "flex", gap: 12 }}>
            <button className="btn" disabled={working} onClick={() => void upgrade(false)}>
              Upgrade to Pro — $5/mo
            </button>
            <button className="btn ghost" disabled={working} onClick={() => void upgrade(true)}>
              Annual — $50/yr
            </button>
          </div>
        ) : (
          <button className="btn ghost" disabled={working} onClick={() => void portal()}>
            Manage billing (Stripe portal)
          </button>
        )
      ) : (
        <p className="muted">Only GitHub organization owners can change billing.</p>
      )}
    </div>
  );
}

function Operations({ me }: { me: Me }) {
  const { data, error, reload } = useFetch<{
    deliveries: Array<{ provider: string; delivery_id: string; event: string; received_at: string }>;
    observations: Array<{ github_name: string; head_sha: string; outcome: string; run_id: string | null; observed_at: string }>;
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
  if (error) return <div className="panel error-note">{error}</div>;
  if (!data) return <div className="panel empty">Loading…</div>;
  return (
    <>
      <div className="panel">
        <h3>GitHub sync</h3>
        <p className="muted" style={{ marginBottom: 10 }}>
          Webhooks keep the projection warm; a full reconciliation re-reads members, teams, repositories, and
          permissions from GitHub.
        </p>
        {me.viewer.githubOrgRole === "owner" ? (
          <button className="btn small" disabled={syncing} onClick={() => void sync()}>
            {syncing ? "Syncing…" : "Run full sync"}
          </button>
        ) : (
          <p className="muted">Org owners can trigger a full sync.</p>
        )}
        {note && <p className="muted code" style={{ marginTop: 8, fontSize: "0.8rem" }}>{note}</p>}
      </div>
      <div className="panel">
        <h3>Recent verifications</h3>
        {data.observations.length === 0 && <p className="empty">No verifications recorded yet.</p>}
        <table className="plain">
          <tbody>
            {data.observations.map((o, i) => (
              <tr key={i}>
                <td className="code">{o.github_name}</td>
                <td className="code">{o.head_sha.slice(0, 12)}</td>
                <td>
                  <span className={o.outcome === "PASS" ? "ok" : "bad"}>{o.outcome}</span>
                </td>
                <td className="muted">{o.observed_at.slice(0, 19)}Z</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Webhook deliveries</h3>
        {data.deliveries.length === 0 && <p className="empty">No deliveries yet.</p>}
        <table className="plain">
          <tbody>
            {data.deliveries.map((d) => (
              <tr key={d.delivery_id}>
                <td>{d.provider}</td>
                <td className="code">{d.event}</td>
                <td className="code" style={{ fontSize: "0.72rem" }}>{d.delivery_id.slice(0, 18)}</td>
                <td className="muted">{d.received_at.slice(0, 19)}Z</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      <div className="shell">
        <div className="panel device-card">
          <h3>Sign in to approve this device</h3>
          <p className="muted" style={{ marginBottom: 14 }}>
            The thwip CLI is waiting for approval. Sign in with GitHub to continue.
          </p>
          <button
            className="btn"
            onClick={() => void signInWithGitHub(`/device?user_code=${encodeURIComponent(code)}`)}
          >
            Sign in with GitHub
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="shell">
      <div className="panel device-card">
        <h3>Approve CLI sign-in</h3>
        {state === "done" ? (
          <p className="ok">Device approved — return to your terminal.</p>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 14 }}>
              Enter the code shown by <span className="code">thwip login</span>.
            </p>
            <input
              className="code"
              style={{ fontSize: "1.3rem", padding: "10px 14px", width: "100%", marginBottom: 14, letterSpacing: "0.2em", textAlign: "center", border: "1px solid var(--hairline)", borderRadius: 3 }}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-label="Device code"
            />
            {message && <p className="error-note">{message}</p>}
            <button className="btn" disabled={state === "working" || code.length < 4} onClick={() => void approve()}>
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
  if (dashMatch) {
    if (me === undefined) return <div className="shell empty" style={{ padding: 60 }}>Loading…</div>;
    if (me === null) {
      return (
        <div className="shell">
          <div className="panel device-card">
            <h3>Sign in to thwip</h3>
            <p className="muted" style={{ marginBottom: 14 }}>
              The dashboard mirrors your GitHub organization — sign in with the account that belongs to it.
            </p>
            <button className="btn" onClick={() => void signInWithGitHub(window.location.pathname)}>
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
