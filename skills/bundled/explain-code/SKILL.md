---
name: explain-code
description: Explain unfamiliar code to the user at the right level of detail. Use when asked how something works.
version: 1.0.0
requiredCapabilities: ["fs.read"]
---

# Explain Code

1. Read the actual code before explaining — never guess from names.
2. Trace one concrete path end-to-end instead of describing everything abstractly.
3. Cite `path:line` for every claim.
4. State what you did NOT verify.
