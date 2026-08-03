import React from "react";
import "./notary.css";

/**
 * The bar and the foot, shared by every public page so the site reads as one
 * document. Links point only at pages that exist.
 */

export interface Viewer {
  organization: { github_login: string } | null;
}

export function SiteBar({ me, signIn }: { me: Viewer | null | undefined; signIn: () => void }) {
  return (
    <header className="nt-bar">
      <a className="nt-mark" href="/">
        thwip
      </a>
      <nav aria-label="Site">
        <a href="/blog">Blog</a>
        <a href="/faq">FAQ</a>
        <a href="/install">Install</a>
        {me ? (
          <a href="/dashboard">Dashboard</a>
        ) : (
          <a
            href="/dashboard"
            onClick={(e) => {
              e.preventDefault();
              signIn();
            }}
          >
            Sign in
          </a>
        )}
      </nav>
    </header>
  );
}

export function SiteFoot() {
  return (
    <footer className="nt-foot">
      <span>
        <a href="/blog">Blog</a>
        <a href="/faq">FAQ</a>
        <a href="/install">Install</a>
        <a href="/rss.xml">RSS</a>
        <a href="/llms.txt">llms.txt</a>
      </span>
      <span>thwip · verified local CI · recall.net</span>
    </footer>
  );
}
