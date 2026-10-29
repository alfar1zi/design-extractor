---
name: Feature request
about: Propose a capability, a new artifact field, or a new capture pass
labels: [enhancement]
---

**What are you trying to rebuild, and what does the capture not tell you**

Describe the page and the decision you could not make from the artifacts. A request
framed as "the capture should say X so a rebuild can do Y" is actionable; "support
more sites" is not.

**Which artifact would carry it**

`tokens.json`, `motion.json`, `states.json`, `components.*.json`, `unproducible.json`,
or a new one. If a new one, say what reads it.

**What it costs**

Every pass adds time to a standard run. Say whether this belongs in `--quick`,
`--standard`, `--full`, or a new flag.
