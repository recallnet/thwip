import { defineMarkdocConfig, component, nodes } from "@astrojs/markdoc/config";
import shiki from "@astrojs/markdoc/shiki";

export default defineMarkdocConfig({
  extends: [
    shiki({
      theme: "github-light",
      wrap: true,
    }),
  ],
  nodes: {
    document: {
      ...nodes.document,
      render: null,
    },
  },
  tags: {
    callout: {
      render: component("./src/components/Callout.astro"),
      attributes: {
        type: {
          type: String,
          default: "note",
          matches: ["note", "tip", "warning"],
        },
        title: { type: String, required: false },
      },
    },
    cta: {
      render: component("./src/components/Cta.astro"),
      attributes: {
        href: { type: String, required: true },
        label: { type: String, required: true },
        variant: {
          type: String,
          default: "primary",
          matches: ["primary", "ghost"],
        },
      },
      selfClosing: true,
    },
    "product-shot": {
      render: component("./src/components/ProductShot.astro"),
      attributes: {
        src: { type: String, required: true },
        alt: { type: String, required: true },
        caption: { type: String, required: false },
      },
      selfClosing: true,
    },
    steps: {
      render: component("./src/components/Steps.astro"),
    },
    step: {
      render: component("./src/components/Step.astro"),
      attributes: {
        title: { type: String, required: true },
      },
    },
  },
});
