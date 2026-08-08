import { describe, expect, it } from "vitest";
import { FAQ_ITEMS } from "./faq.js";

/**
 * The FAQ content is rendered in two places — the dashboard page and the
 * published /faq.md — from this one list. These tests hold the shape that
 * both renderers depend on, so a content edit that would break one of them
 * fails here instead of on a page nobody reads until it ships.
 */

const INLINE_MARKUP = /`[^`\n]+`|\*\*[^*\n]+\*\*/;

describe("FAQ content", () => {
  it("keeps the questions the page and the markdown must agree on", () => {
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(15);
  });

  it("gives every question a unique anchor id", () => {
    const ids = FAQ_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("answers every question in prose", () => {
    for (const item of FAQ_ITEMS) {
      expect(item.q.trim(), item.id).not.toBe("");
      expect(item.a.trim().length, item.id).toBeGreaterThan(40);
    }
  });

  it("uses only the inline markup both renderers understand", () => {
    for (const item of FAQ_ITEMS) {
      expect(item.a, item.id).not.toMatch(/<[a-z]+>/i);
      expect(item.a, item.id).not.toMatch(/\n/);
    }
  });

  it("keeps code spans closed", () => {
    for (const item of FAQ_ITEMS) {
      const spans = item.a.match(/`/g) ?? [];
      expect(spans.length % 2, item.id).toBe(0);
      for (const match of item.a.matchAll(/`([^`]*)`/g)) {
        expect(match[1]!.trim(), item.id).not.toBe("");
      }
    }
  });

  it("uses inline markup somewhere, so the renderers are exercised", () => {
    expect(FAQ_ITEMS.some((item) => INLINE_MARKUP.test(item.a))).toBe(true);
  });
});
