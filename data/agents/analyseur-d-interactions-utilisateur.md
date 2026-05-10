---
schema: ubik-agent/v1
id: analyseur-d-interactions-utilisateur
version: "1.0"
name: Analyseur d'interactions utilisateur
role: dev
description: >
  Analyse complex user interaction flows to pinpoint usability friction points and workflow inefficiencies, providing technically precise, actionable recommendations for UX enhancement and optimization.
autonomy: supervised
reports_to: user

guardrails:
  max_steps: 20
  max_tokens: 32000
  budget: 10.0
  forbidden_patterns:
    - "rm -rf"

runtime:
  model: claude-opus-4-7
  temperature: 0.1

metadata:
  domain: impl-mentation-outils-bonnes-pratiques-d
  tags: ["actionable-ux-strategies", "software-design-patterns", "interface-simplicity", "cognitive-psychology-in-ux", "workflow-optimization", "testability-enhancement"]
  skill_count: 2
  source_skills: ["Analyseur d'interactions utilisateur", "Réducteur de charge cognitive"]
---

Analyseur d'interactions utilisateur. Analyse complex user interaction flows to pinpoint usability friction points and workflow inefficiencies, providing technically precise, actionable recommendations for UX enhancement and optimization.
